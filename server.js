const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const levenshtein = require('fast-levenshtein');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const CACHE_FILE_PATH = path.join(__dirname, 'quizzes_cache.json');
const DEFAULT_QUIZZES = [
    {
        genre: "一般", difficulty: "中級", keyword: "",
        question: "1989年に日本で導入され当初は3%だった、商品の購入時などに広く課される税金は何でしょう？",
        answers: ["消費税", "しょうひぜい"],
        explanation: "正解は消費税です。段階的に税率が引き上げられてきました。"
    }
];

let roomState = {
    status: 'LOBBY',
    hostId: null,
    config: { 
        genre: '一般', difficulty: '中級', keyword: '', count: 5,
        continueOnWrong: true, wrongLimit: 2, answerLimit: 10, thinkingLimit: 7, plusScore: 10, minusScore: 5            
    },
    players: {}, quizzes: [], currentQuizIndex: 0, activePlayerId: null,
    textTimer: null, answerTimer: null, thinkingTimer: null, displayedTextLength: 0,
    wrongCountsInRound: {},      
    confirmedPlayers: {},
    roundAnswersLog: [],
    gameWrongCounts: {}, // プレイヤーごとの累計お手つき数 { socketId: count }
    isDisqualified: {},   // プレイヤーが失格しているか { socketId: true/false }
    isGameOverPending: false
};

function initGame() {
    roomState.currentQuizIndex = 0;
    roomState.gameWrongCounts = {};
    roomState.isDisqualified = {};
    roomState.isGameOverPending = false;
    for (let id in roomState.players) {
        roomState.players[id].currentScore = 0;
        roomState.gameWrongCounts[id] = 0;
        roomState.isDisqualified[id] = false;
    }
}

// --- Gemini API & 最適化された高速生成ロジック ---
async function generateQuizzes(config) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
        // 最大2回までチャレンジする
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`Gemini API で高速逆算クイズを生成中... (試行 ${attempt} 回目)`);
                const ai = new GoogleGenAI({ apiKey: apiKey });
                
                const prompt = `
                条件に従う早押しクイズを【JSON配列のみ】で出力。説明不要。
                条件:
                - ジャンル: ${config.genre}
                - 難易度: ${config.difficulty}
                - 縛りキーワード: ${config.keyword || "特になし"}
                - 問題数: ${config.count}
                - 【最重要・問題文のルール】: 正解を先に決め、マニアックな情報（難）から有名な情報（易）へと、段階的にヒントを並べる「逆算の法則」を徹底すること。文字数は50文字〜80文字目安。
                フォーマット:
                [{"question": "問題文","answers": ["正解", "ひらがな正解"],"explanation": "解説"}]`;

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash', 
                    contents: prompt,
                });

                const text = response.text.trim();
                const jsonString = text.replace(/^```json/, '').replace(/```$/, '').trim();
                const newQuizzes = JSON.parse(jsonString);

                const quizzesWithMeta = newQuizzes.map(q => ({
                    ...q, genre: config.genre, difficulty: config.difficulty, keyword: config.keyword
                }));

                saveQuizzesToCache(quizzesWithMeta);
                return quizzesWithMeta; // 成功したらここで関数を抜ける

            } catch (error) {
                console.error(`試行 ${attempt} 回目でエラーが発生しました:`, error.message);
                
                // 1回目の失敗かつ503エラーなら、1.5秒待って次ループ（再チャレンジ）へ
                if (attempt === 1 && error.message.includes("503")) {
                    console.log("503高負荷エラーのため、1.5秒後に再試行します...");
                    await new Promise(resolve => setTimeout(resolve, 1500));
                } else {
                    // 2回目もダメ、または503以外の致命的エラーならループを抜けてキャッシュ処理へ
                    break;
                }
            }
        }
    }
    
    console.log("Gemini APIが利用できないため、キャッシュデータから取得します。");
    // キャッシュからの検索（お題縛りも考慮）
    const cachedData = loadQuizzesFromCache();
    const filtered = cachedData.filter(q => 
        q.genre === config.genre && 
        q.difficulty === config.difficulty &&
        (!config.keyword || q.keyword === config.keyword)
    );

    if (filtered.length >= config.count) {
        return filtered.sort(() => 0.5 - Math.random()).slice(0, config.count);
    }
    return DEFAULT_QUIZZES;
}

function loadQuizzesFromCache() {
    try { if (fs.existsSync(CACHE_FILE_PATH)) return JSON.parse(fs.readFileSync(CACHE_FILE_PATH, 'utf-8')); } catch (e) {}
    return [...DEFAULT_QUIZZES];
}
function saveQuizzesToCache(newQuizzes) {
    try {
        let currentCache = loadQuizzesFromCache();
        newQuizzes.forEach(newQ => { if (!currentCache.some(cacheQ => cacheQ.question === newQ.question)) currentCache.push(newQ); });
        fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(currentCache, null, 2), 'utf-8');
    } catch (e) {}
}

function checkAnswer(input, validAnswers) {
    const normalizedInput = input.trim().toLowerCase().replace(/\s+/g, '');
    for (let answer of validAnswers) {
        const normalizedAnswer = answer.trim().toLowerCase().replace(/\s+/g, '');
        if (normalizedInput === normalizedAnswer) return true;
        if (normalizedAnswer.length >= 4 && levenshtein.get(normalizedInput, normalizedAnswer) <= 1) return true;
    }
    return false;
}

io.on('connection', (socket) => {
    const nickname = socket.handshake.query.name || `ゲスト_${socket.id.slice(0,4)}`;
    const isFirstPlayer = Object.keys(roomState.players).length === 0;

    roomState.players[socket.id] = { id: socket.id, name: nickname, currentScore: 0, totalScore: 0 };
    if (isFirstPlayer) roomState.hostId = socket.id;
    io.emit('room-update', roomState);

    // 設定変更
    socket.on('set-config', (newConfig) => {
        // ホスト以外の不正操作をガード
        if (socket.id !== roomState.hostId) return;
    
        // 部屋の設定を安全に更新
        roomState.config = {
            genre: String(newConfig.genre || '一般'),
            keyword: String(newConfig.keyword || ''),
            difficulty: String(newConfig.difficulty || '中級'),
            count: parseInt(newConfig.count) || 5,
            continueOnWrong: newConfig.continueOnWrong === true,
            wrongLimit: parseInt(newConfig.wrongLimit) || 2,
            answerLimit: parseInt(newConfig.answerLimit) || 10,
            thinkingLimit: parseInt(newConfig.thinkingLimit) || 7,
            plusScore: parseInt(newConfig.plusScore) || 10,
            minusScore: parseInt(newConfig.minusScore) || 5
        };
        roomState.config.winScore = parseInt(newConfig.winScore) || 30; // 追加
        roomState.config.gameWrongLimit = parseInt(newConfig.gameWrongLimit) || 3; // 追加
    
        console.log('ゲーム設定が更新されました:', roomState.config);
    
        // ★【ここが漏れていました】設定完了を「config-saved」イベントで全員に通知！
        io.emit('config-saved', `⚙️ ホストによってゲーム設定が更新・同期されました！`);
    
        // 全員の画面（グレーアウトやフォームの値）を一斉に最新状態に同期
        io.emit('room-update', roomState);
    });
    
    // ゲーム開始
    socket.on('game-start', async () => {
        if (roomState.status !== 'LOBBY' || socket.id !== roomState.hostId) return;
        io.emit('generating-quizzes', '逆算思考で問題を生成中です。少々お待ちください...');
        
        Object.keys(roomState.players).forEach(id => { roomState.players[id].currentScore = 0; });
        roomState.quizzes = await generateQuizzes(roomState.config);
        roomState.currentQuizIndex = 0;
        startQuizRound();
    });

    // 早押しボタン
    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        // お手つき制限に達しているプレイヤーは押せない
        const currentWrongCount = roomState.wrongCountsInRound[socket.id] || 0;
        if (currentWrongCount >= roomState.config.wrongLimit) return;

        clearInterval(roomState.textTimer);
        clearInterval(roomState.thinkingTimer);

        roomState.status = 'QUIZ_ANSWER';
        roomState.activePlayerId = socket.id;
        
        io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });
        io.emit('room-update', roomState);

        let countdown = roomState.config.answerLimit;
        io.emit('answer-timer', countdown);
        roomState.answerTimer = setInterval(() => {
            countdown--;
            io.emit('answer-timer', countdown);
            if (countdown <= 0) {
                clearInterval(roomState.answerTimer);
                submitAnswer(""); 
            }
        }, 1000);
    });

    // 回答提出
    socket.on('submit-answer', (answerText) => {
        if (roomState.status !== 'QUIZ_ANSWER' || roomState.activePlayerId !== socket.id) return;
        clearInterval(roomState.answerTimer);
        submitAnswer(answerText);
    });

    // 解答提出のロジック
    function submitAnswer(answerText) {
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        const isCorrect = checkAnswer(answerText, quiz.answers);
        const pid = roomState.activePlayerId;
        const pName = pid ? roomState.players[pid].name : "なし";
    
        if (pid) {
            roomState.roundAnswersLog.push({
                playerId: pid, name: pName, text: answerText || "(タイムアウト)", isCorrect: isCorrect,
                originalPoints: isCorrect ? roomState.config.plusScore : -roomState.config.minusScore // 元の増減幅を記録
            });
        }
    
        if (isCorrect) {
            if (pid) {
                roomState.players[pid].currentScore += roomState.config.plusScore;
                roomState.players[pid].totalScore += roomState.config.plusScore;
                
                // ★修正：ここでは即終了せず、フラグだけ立てて解説画面へ進む
                if (roomState.players[pid].currentScore >= roomState.config.winScore) {
                    roomState.isGameOverPending = true;
                }
            }
            goToResultView(isCorrect, answerText, quiz);
        } else {
            if (pid) {
                roomState.players[pid].currentScore -= roomState.config.minusScore;
                roomState.players[pid].totalScore -= roomState.config.minusScore;
                roomState.wrongCountsInRound[pid] = (roomState.wrongCountsInRound[pid] || 0) + 1;
                roomState.gameWrongCounts[pid] = (roomState.gameWrongCounts[pid] || 0) + 1;
    
                if (roomState.gameWrongCounts[pid] >= roomState.config.gameWrongLimit) {
                    roomState.isDisqualified[pid] = true;
                    io.emit('host-override-notice', `🚨 ${pName} さんが累計お手つき上限に達したため【失格】となりました！`);
                }
            }
    
            const totalPlayers = Object.keys(roomState.players);
            const alivePlayers = totalPlayers.filter(id => !roomState.isDisqualified[id] && (roomState.wrongCountsInRound[id] || 0) < roomState.config.wrongLimit);
    
            if (roomState.config.continueOnWrong && alivePlayers.length > 0) {
                io.emit('wrong-mid-quiz', { wrongPlayer: pName, answerText: answerText || "(タイムアウト)", roomState: roomState });
                resumeQuizRound();
            } else {
                // 全員失格か、これ以上回答者がいない場合
                const querySurvivers = totalPlayers.filter(id => !roomState.isDisqualified[id]);
                if (querySurvivers.length === 0) {
                    roomState.isGameOverPending = true;
                }
                goToResultView(isCorrect, answerText, quiz);
            }
        }
    }

    // 確認完了して次へ進むボタンが押されたとき
    function handleConfirmNext(socketId) {
        roomState.confirmedPlayers[socketId] = true;
        io.emit('confirm-update', roomState.confirmedPlayers);
    
        const totalPlayersCount = Object.keys(roomState.players).length;
        const confirmedCount = Object.keys(roomState.confirmedPlayers).length;
    
        if (confirmedCount >= totalPlayersCount) {
            // ★修正：確認終了後に、決着フラグが立っていれば最終結果画面（GAME_OVER）へ飛ばす
            if (roomState.isGameOverPending) {
                roomState.status = 'GAME_OVER';
                io.emit('room-update', roomState);
                io.emit('game-over', roomState.players);
                return;
            }
    
            roomState.currentQuizIndex++;
            if (roomState.currentQuizIndex >= roomState.quizzes.length) {
                roomState.status = 'GAME_OVER';
                io.emit('room-update', roomState);
                io.emit('game-over', roomState.players);
            } else {
                startQuizRound();
            }
        }
    }
    
    // 先取勝利時の強制終了
    function endGameWithWinner(winnerName) {
        roomState.status = 'QUIZ_RESULT'; // 一旦リザルトを見せる
        io.emit('game-over-winner', { winner: winnerName, msg: `🎉 ${winnerName} さんが規定の ${roomState.config.winScore} 点に達したため、クイズを終了します！勝利おめでとうございます！` });
    }
    
    // 全員失格時の強制終了
    function endGameWithNoSurvivers() {
        roomState.status = 'QUIZ_RESULT';
        io.emit('game-over-winner', { winner: "なし", msg: `💀 生存しているプレイヤーが全員【失格】となったため、ゲームを途中で終了します。` });
    }
    
    // ★2. ホスト用強制コマンドの処理
    socket.on('host-control', (data) => {
        if (socket.id !== roomState.hostId) return; 
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
    
        if (data.action === 'skip') {
            clearInterval(roomState.textTimer);
            clearInterval(roomState.thinkingTimer);
            clearInterval(roomState.answerTimer);
            goToResultView(false, "(ホストによる強制スキップ)", quiz);
        } 
        // ピンポイント判定上書き
        else if (data.action === 'override-log-status') {
            const targetPid = data.playerId;
            const targetLogIndex = data.logIndex;
            const newStatus = data.newStatus; // 'correct' | 'wrong' | 'nocount'
            
            const logItem = roomState.roundAnswersLog[targetLogIndex];
            if (!logItem || logItem.playerId !== targetPid) return;
        
            // 現在のステータス
            const currentStatus = logItem.isCorrect === true ? 'correct' : (logItem.isCorrect === false ? 'wrong' : 'nocount');
            if (newStatus === currentStatus) return;
        
            // --- 1. まず直前の判定によるスコア・お手つきの変動を「引き算（巻き戻し）」する ---
            if (currentStatus === 'correct') {
                roomState.players[targetPid].currentScore -= roomState.config.plusScore;
                roomState.players[targetPid].totalScore -= roomState.config.plusScore;
            } else if (currentStatus === 'wrong') {
                roomState.players[targetPid].currentScore += roomState.config.minusScore;
                roomState.players[targetPid].totalScore += roomState.config.minusScore;
                roomState.gameWrongCounts[targetPid] = Math.max(0, (roomState.gameWrongCounts[targetPid] || 0) - 1);
                if (roomState.gameWrongCounts[targetPid] < roomState.config.gameWrongLimit) {
                    roomState.isDisqualified[targetPid] = false; // 失格を解除
                }
            }
        
            // --- 2. 新しいステータスを適用し、「足し算」する ---
            if (newStatus === 'correct') {
                roomState.players[targetPid].currentScore += roomState.config.plusScore;
                roomState.players[targetPid].totalScore += roomState.config.plusScore;
                logItem.isCorrect = true;
                io.emit('host-override-notice', `👑ホスト権限：${logItem.name} さんの解答を【正解◯】に変更しました！`);
            } else if (newStatus === 'wrong') {
                roomState.players[targetPid].currentScore -= roomState.config.minusScore;
                roomState.players[targetPid].totalScore -= roomState.config.minusScore;
                logItem.isCorrect = false;
                roomState.gameWrongCounts[targetPid] = (roomState.gameWrongCounts[targetPid] || 0) + 1;
                if (roomState.gameWrongCounts[targetPid] >= roomState.config.gameWrongLimit) {
                    roomState.isDisqualified[targetPid] = true;
                }
                io.emit('host-override-notice', `👑ホスト権限：${logItem.name} さんの解答を【不正解✕】に変更しました。`);
            } else if (newStatus === 'nocount') {
                logItem.isCorrect = null; // null をノーカウントの印にする
                io.emit('host-override-notice', `👑ホスト権限：${logItem.name} さんの解答を【ノーカウント（ペナルティなし）】にしました！`);
            }
        
            // 先取勝敗・サドンデス失格の再チェック
            const totalPlayers = Object.keys(roomState.players);
            const hasWinner = totalPlayers.some(id => roomState.players[id].currentScore >= roomState.config.winScore);
            const hasSurvivers = totalPlayers.some(id => !roomState.isDisqualified[id]);
            
            roomState.isGameOverPending = hasWinner || !hasSurvivers;
        
            // リフレッシュ送信
            io.emit('quiz-round-result', {
                isCorrect: roomState.roundAnswersLog[roomState.roundAnswersLog.length - 1].isCorrect,
                answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
                answerText: roomState.roundAnswersLog[roomState.roundAnswersLog.length - 1].text,
                correctAnswer: quiz.answers[0],
                explanation: quiz.explanation,
                fullQuestion: quiz.question,
                answersLog: roomState.roundAnswersLog
            });
            io.emit('room-update', roomState);
        }
        // ★追加：ロビーに戻るリセットコマンド
        else if (data.action === 'return-to-lobby') {
            roomState.status = 'LOBBY';
            roomState.quizzes = [];
            roomState.currentQuizIndex = 0;
            roomState.isGameOverPending = false;
            for (let id in roomState.players) {
                roomState.players[id].currentScore = 0;
                roomState.gameWrongCounts[id] = 0;
                roomState.isDisqualified[id] = false;
            }
            io.emit('room-update', roomState);
        }
    });
    
    // 結果画面への移行
    function goToResultView(isCorrect, answerText, quiz) {
        roomState.status = 'QUIZ_RESULT';
        roomState.confirmedPlayers = {}; 
        
        io.emit('quiz-round-result', {
            isCorrect,
            answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
            answerText: answerText,
            correctAnswer: quiz.answers[0],
            explanation: quiz.explanation,
            fullQuestion: quiz.question,
            answersLog: roomState.roundAnswersLog // ★追加：解答履歴ログをフロントへ送信
        });
        io.emit('room-update', roomState);
    }
    
    function resumeQuizRound() {
        roomState.status = 'QUIZ_TEXT';
        roomState.activePlayerId = null;
        io.emit('room-update', roomState);
        
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        if (roomState.displayedTextLength < quiz.question.length) {
            runTextTimer(quiz);
        } else {
            startThinkingTimer(quiz);
        }
    }

    socket.on('confirm-next', () => {
        if (roomState.status !== 'QUIZ_RESULT') return;
        roomState.confirmedPlayers[socket.id] = true;
        checkAllConfirmed();
    });

    function checkAllConfirmed() {
        const activePlayerIds = Object.keys(roomState.players);
        const isAllConfirmed = activePlayerIds.every(id => roomState.confirmedPlayers[id] === true);

        if (isAllConfirmed) {
            roomState.currentQuizIndex++;
            if (roomState.currentQuizIndex < roomState.quizzes.length) {
                startQuizRound();
            } else {
                roomState.status = 'LOBBY';
                io.emit('game-over', roomState.players);
                io.emit('room-update', roomState);
            }
        } else {
            io.emit('confirm-update', roomState.confirmedPlayers);
        }
    }

    socket.on('disconnect', () => {
        delete roomState.players[socket.id];
        delete roomState.confirmedPlayers[socket.id];
        
        if (socket.id === roomState.hostId) {
            const remainingPlayerIds = Object.keys(roomState.players);
            roomState.hostId = remainingPlayerIds.length > 0 ? remainingPlayerIds[0] : null;
        }
        io.emit('room-update', roomState);
        if (roomState.status === 'QUIZ_RESULT') { checkAllConfirmed(); }
    });
});

// クイズラウンド開始時の初期化
function startQuizRound() {
    roomState.status = 'QUIZ_TEXT';
    roomState.activePlayerId = null;
    roomState.displayedTextLength = 0;
    roomState.wrongCountsInRound = {}; 
    roomState.roundAnswersLog = []; // ★追加：ログをリセット
    const quiz = roomState.quizzes[roomState.currentQuizIndex];

    io.emit('quiz-start', { index: roomState.currentQuizIndex });
    io.emit('room-update', roomState);
    runTextTimer(quiz);
}

function runTextTimer(quiz) {
    roomState.textTimer = setInterval(() => {
        roomState.displayedTextLength++;
        const currentText = quiz.question.substring(0, roomState.displayedTextLength);
        io.emit('quiz-text-chunk', { text: currentText });

        if (roomState.displayedTextLength >= quiz.question.length) {
            clearInterval(roomState.textTimer);
            startThinkingTimer(quiz); 
        }
    }, 150);
}

function startThinkingTimer(quiz) {
    let thinkingCountdown = roomState.config.thinkingLimit;
    
    // 最初の一秒目を即座に通知
    io.emit('thinking-timer', thinkingCountdown);

    // 以前のタイマーが万が一残っていたら確実にクリアしておく安全策
    clearInterval(roomState.thinkingTimer);

    roomState.thinkingTimer = setInterval(() => {
        thinkingCountdown--;
        io.emit('thinking-timer', thinkingCountdown);

        if (thinkingCountdown <= 0) {
            // ★【重要バグ修正】: カウントが0になったら、即座にこのインターバルタイマーを消滅させる！
            clearInterval(roomState.thinkingTimer); 
            roomState.thinkingTimer = null; // 完全に参照をクリア
            
            // 誰もおさずにタイムアップしたため、結果表示画面へ移行
            roomState.status = 'QUIZ_RESULT';
            roomState.confirmedPlayers = {};
            
            io.emit('quiz-round-result', {
                isCorrect: false,
                answeredPlayer: "なし",
                answerText: "(タイムアップ)",
                correctAnswer: quiz.answers[0],
                explanation: quiz.explanation,
                fullQuestion: quiz.question 
            });
            io.emit('room-update', roomState);
        }
    }, 1000);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
