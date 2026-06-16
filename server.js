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
        genre: "一般", difficulty: "中級",
        question: "日本の現在の首都であり、世界最大の人口を有する都市はどこでしょう？",
        answers: ["東京", "とうきょう", "tokyo", "東京都"],
        explanation: "日本の事実上の首都は東京都です。"
    }
];

let roomState = {
    status: 'LOBBY',
    hostId: null, // ★追加：現在誰がホスト（室長）なのかのSocketIDを保持
    config: { 
        genre: '一般', 
        difficulty: '中級', 
        count: 5,
        continueOnWrong: true,   // 誤答時に早押し続行するか
        answerLimit: 10,         // 解答制限時間(秒)
        thinkingLimit: 7,        // 読み上げ後の猶予時間(秒)
        plusScore: 10,           // 正解時の加点
        minusScore: 5            // 誤答時の減点
    },
    players: {}, 
    quizzes: [],
    currentQuizIndex: 0,
    activePlayerId: null,
    textTimer: null,
    answerTimer: null,
    thinkingTimer: null,         // 読み上げ後の猶予用タイマー
    displayedTextLength: 0,
    wrongPlayersInRound: [],     // このラウンドで誤答して解答権を失った人
    confirmedPlayers: {}         // 確認ボタンを押したプレイヤーの記録 { socketId: true }
};

// --- Gemini API & キャッシュロジック (前回同様のため省略可、内部処理は維持) ---
async function generateQuizzes(config) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
        try {
            const ai = new GoogleGenAI({ apiKey: apiKey });
            const prompt = `ジャンル: ${config.genre}, 難易度: ${config.difficulty}, 問題数: ${config.count}の早押しクイズを、以下のフォーマットのJSON配列のみで出力してください。[\n  {\n    "question": "問題文",\n    "answers": ["正解", "別解"],\n    "explanation": "解説"\n  }\n]|「問題文」は「逆算の法則」（正解を先に決め、マニアックな情報（難）から有名な情報（易）へと、段階的にヒントを並べる）を用いて50文字〜80文字程度を目安に作成してください。`;
            const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
            const jsonString = response.text.trim().replace(/^```json/, '').replace(/```$/, '').trim();
            const newQuizzes = JSON.parse(jsonString);
            const quizzesWithMeta = newQuizzes.map(q => ({ ...q, genre: config.genre, difficulty: config.difficulty }));
            saveQuizzesToCache(quizzesWithMeta);
            return quizzesWithMeta;
        } catch (error) {
            console.error("Gemini Error:", error);
        }
    }
    const cachedData = loadQuizzesFromCache();
    const filtered = cachedData.filter(q => q.genre === config.genre && q.difficulty === config.difficulty);
    if (filtered.length >= config.count) return filtered.sort(() => 0.5 - Math.random()).slice(0, config.count);
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
    
    // 1. プレイヤーを登録する前に、部屋が空（＝自分が最初の1人目）か確認
    const isFirstPlayer = Object.keys(roomState.players).length === 0;

    roomState.players[socket.id] = { 
        id: socket.id, 
        name: nickname, 
        currentScore: 0, 
        totalScore: 0 
    };

    // 2. 最初の1人目なら、その人をホストに指名
    if (isFirstPlayer) {
        roomState.hostId = socket.id;
        console.log(`初代ホストが決定しました: ${nickname}`);
    }

    io.emit('room-update', roomState);

    // 3. 【権限チェック】設定変更
    socket.on('set-config', (config) => {
        if (roomState.status !== 'LOBBY') return;
        // 送信者がホストではない場合は拒否
        if (socket.id !== roomState.hostId) {
            socket.emit('config-saved', 'エラー：設定を変更できるのはホストだけです。');
            return;
        }
        roomState.config = config;
        socket.emit('config-saved', '設定を保存しました！');
        io.emit('room-update', roomState);
    });

    // 4. 【権限チェック】ゲーム開始
    socket.on('game-start', async () => {
        if (roomState.status !== 'LOBBY') return;
        // 送信者がホストではない場合は無視
        if (socket.id !== roomState.hostId) return;

        io.emit('generating-quizzes', '問題を生成中です。少々お待ちください...');
        
        Object.keys(roomState.players).forEach(id => { roomState.players[id].currentScore = 0; });
        roomState.quizzes = await generateQuizzes(roomState.config);
        roomState.currentQuizIndex = 0;
        startQuizRound();
    });

    // 早押しボタン
    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        // すでにこのラウンドで誤答しているプレイヤーはスルー
        if (roomState.wrongPlayersInRound.includes(socket.id)) return;

        // 流れている文字送り、または猶予タイマーを止める
        clearInterval(roomState.textTimer);
        clearTimeout(roomState.thinkingTimer);

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

    function submitAnswer(answerText) {
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        const isCorrect = checkAnswer(answerText, quiz.answers);
        const pid = roomState.activePlayerId;

        if (isCorrect) {
            // 正解時
            if (pid) {
                roomState.players[pid].currentScore += roomState.config.plusScore;
                roomState.players[pid].totalScore += roomState.config.plusScore;
            }
            goToResultView(isCorrect, answerText, quiz);
        } else {
            // 誤答時
            if (pid) {
                roomState.players[pid].currentScore -= roomState.config.minusScore;
                roomState.players[pid].totalScore -= roomState.config.minusScore;
                roomState.wrongPlayersInRound.push(pid); // 誤答リスト入り
            }

            // まだ解答していない人がいて、かつ「誤答時続行」がONなら、早押しを再開
            const totalPlayers = Object.keys(roomState.players).length;
            if (roomState.config.continueOnWrong && roomState.wrongPlayersInRound.length < totalPlayers) {
                resumeQuizRound();
            } else {
                // 全員誤答、または続行OFFなら結果表示へ
                goToResultView(isCorrect, answerText, quiz);
            }
        }
    }

    // 結果・解説画面への移行
    function goToResultView(isCorrect, answerText, quiz) {
        roomState.status = 'QUIZ_RESULT';
        roomState.confirmedPlayers = {}; // 確認状況リセット
        
        io.emit('quiz-round-result', {
            isCorrect,
            answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
            answerText: answerText,
            correctAnswer: quiz.answers[0],
            explanation: quiz.explanation
        });
        io.emit('room-update', roomState);
    }

    // 早押し継続処理
    function resumeQuizRound() {
        roomState.status = 'QUIZ_TEXT';
        roomState.activePlayerId = null;
        io.emit('room-update', roomState);
        
        // 残りの問題文があれば文字送りを再開、なければ猶予タイマーを再開
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        if (roomState.displayedTextLength < quiz.question.length) {
            runTextTimer(quiz);
        } else {
            startThinkingTimer(quiz);
        }
    }

    // 確認ボタンが押されたとき
    socket.on('confirm-next', () => {
        if (roomState.status !== 'QUIZ_RESULT') return;
        roomState.confirmedPlayers[socket.id] = true;
        
        checkAllConfirmed();
    });

    function checkAllConfirmed() {
        // 現在接続しているプレイヤー全員が確認したかチェック
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
            // 現在の確認状況を全員に同期
            io.emit('confirm-update', roomState.confirmedPlayers);
        }
    }

    // 5. 切断時のホスト引き継ぎロジック
    socket.on('disconnect', () => {
        console.log(`ユーザー切断: ${roomState.players[socket.id]?.name}`);
        delete roomState.players[socket.id];
        delete roomState.confirmedPlayers[socket.id];

        // もし切断したのがホストだった場合、ホスト権限を移譲する
        if (socket.id === roomState.hostId) {
            const remainingPlayerIds = Object.keys(roomState.players);
            if (remainingPlayerIds.length > 0) {
                // 残ったプレイヤーの先頭（次に入室が早かった人）を新ホストにする
                roomState.hostId = remainingPlayerIds[0];
                console.log(`ホストが切断したため、新ホストに権限を移譲しました: ${roomState.players[roomState.hostId].name}`);
            } else {
                // 誰もいなくなったらホストを空にする
                roomState.hostId = null;
            }
        }

        io.emit('room-update', roomState);
        if (roomState.status === 'QUIZ_RESULT') { checkAllConfirmed(); }
    });
});

function startQuizRound() {
    roomState.status = 'QUIZ_TEXT';
    roomState.activePlayerId = null;
    roomState.displayedTextLength = 0;
    roomState.wrongPlayersInRound = []; // ラウンド毎にリセット
    const quiz = roomState.quizzes[roomState.currentQuizIndex];

    io.emit('quiz-start', { index: roomState.currentQuizIndex });
    io.emit('room-update', roomState);

    runTextTimer(quiz);
}

// 文字送りロジックを分離
function runTextTimer(quiz) {
    roomState.textTimer = setInterval(() => {
        roomState.displayedTextLength++;
        const currentText = quiz.question.substring(0, roomState.displayedTextLength);
        io.emit('quiz-text-chunk', { text: currentText });

        if (roomState.displayedTextLength >= quiz.question.length) {
            clearInterval(roomState.textTimer);
            startThinkingTimer(quiz); // 読み上げ後の猶予時間へ
        }
    }, 150);
}

// 読み上げ後の猶予時間（シンキングタイム）タイマー
function startThinkingTimer(quiz) {
    roomState.thinkingTimer = setTimeout(() => {
        // 猶予時間内に誰も押さなかったら結果画面へ一変
        roomState.status = 'QUIZ_RESULT';
        roomState.confirmedPlayers = {};
        io.emit('quiz-round-result', {
            isCorrect: false,
            answeredPlayer: "なし",
            answerText: "(タイムアップ)",
            correctAnswer: quiz.answers[0],
            explanation: quiz.explanation
        });
        io.emit('room-update', roomState);
    }, roomState.config.thinkingLimit * 1000);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
