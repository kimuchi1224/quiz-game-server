const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const { GoogleGenAI } = require('@google/genai');

// Gemini APIの初期化（環境変数から取得）
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let roomState = {
    status: 'LOBBY',
    hostId: null,
    config: { 
        genre: '一般', difficulty: '中級', keyword: '', count: 5,
        continueOnWrong: true, wrongLimit: 2, gameWrongLimit: 3, winScore: 30,
        answerLimit: 10, thinkingLimit: 7, plusScore: 10, minusScore: 5            
    },
    players: {}, quizzes: [], currentQuizIndex: 0, activePlayerId: null,
    textTimer: null, answerTimer: null, thinkingTimer: null, displayedTextLength: 0,
    wrongCountsInRound: {},      
    confirmedPlayers: {},
    roundAnswersLog: [],
    gameWrongCounts: {}, 
    isDisqualified: {},
    isGameOverPending: false
};

// 高度な表記ゆれ吸収ロジック
function checkAnswer(userAns, correctAnswers) {
    if (!userAns) return false;
    
    // 正規化関数：ひらがな・カタカナの変換、大文字小文字、全角半角の統一
    const normalize = (str) => {
        return str.trim()
            .toLowerCase()
            .replace(/[\u30a1-\u30f6]/g, match => String.fromCharCode(match.charCodeAt(0) - 0x60)) // カタカナをひらがなに
            .replace(/[\uFF01-\uFF5E]/g, match => String.fromCharCode(match.charCodeAt(0) - 0xfee0)) // 全角英数を半角に
            .replace(/[ーｰ➖━]/g, '') // 長音記号の無視
            .replace(/[\s ]/g, ''); // 空白の除去
    };

    const normUser = normalize(userAns);
    return correctAnswers.some(ans => {
        const normAns = normalize(ans);
        // 完全一致、またはお互いに内包しているか（短い解答の誤判定を防ぐため3文字以上で部分一致も許容）
        if (normUser === normAns) return true;
        if (normAns.length >= 3 && (normUser.includes(normAns) || normAns.includes(normUser))) return true;
        return false;
    });
}

io.on('connection', (socket) => {
    const name = socket.handshake.query.name || "名無し";
    
    if (!roomState.hostId) roomState.hostId = socket.id;
    roomState.players[socket.id] = { id: socket.id, name: name, currentScore: 0, totalScore: 0 };
    roomState.gameWrongCounts[socket.id] = 0;
    roomState.isDisqualified[socket.id] = false;

    io.emit('room-update', roomState);

    // 設定反映
    socket.on('set-config', (newConfig) => {
        if (socket.id !== roomState.hostId) return;
        roomState.config.genre = String(newConfig.genre || '一般');
        roomState.config.keyword = String(newConfig.keyword || '');
        roomState.config.difficulty = String(newConfig.difficulty || '中級');
        roomState.config.count = parseInt(newConfig.count) || 5;
        roomState.config.continueOnWrong = newConfig.continueOnWrong === true;
        roomState.config.wrongLimit = parseInt(newConfig.wrongLimit) || 2;
        roomState.config.winScore = parseInt(newConfig.winScore) || 30;
        roomState.config.gameWrongLimit = parseInt(newConfig.gameWrongLimit) || 3;
        roomState.config.answerLimit = parseInt(newConfig.answerLimit) || 10;
        roomState.config.thinkingLimit = parseInt(newConfig.thinkingLimit) || 7;
        roomState.config.plusScore = parseInt(newConfig.plusScore) || 10;
        roomState.config.minusScore = parseInt(newConfig.minusScore) || 5;

        io.emit('config-saved', `⚙️ ゲーム設定が更新されました！（${roomState.config.winScore}点先取 / 失格${roomState.config.gameWrongLimit}回）`);
        io.emit('room-update', roomState);
    });

    // AIによるクイズ生成とゲーム開始
    socket.on('game-start', async () => {
        if (socket.id !== roomState.hostId) return;
        io.emit('generating-quizzes', "🤖 Gemini AIが厳選クイズを自動生成中。まもなく始まります...");

        try {
            const prompt = `
            以下の条件で面白い早押しクイズ問題を${roomState.config.count}問作成し、指定のJSON形式のみで出力してください。
            ジャンル: ${roomState.config.genre}
            難易度: ${roomState.config.difficulty}
            キーワード・お題の縛り: ${roomState.config.keyword || 'なし'}

            【出力JSONフォーマット】
            [
              {
                "question": "問題文（早押しクイズらしく、徐々に詳細が明かされる文章にしてください）",
                "answers": ["模範解答（漢字）", "ひらがな", "別解やカタカナなど表記ゆれ候補"],
                "explanation": "正解の解説文"
              }
            ]
            JSON以外の余計なテキスト、\`\`\`json などのマークダウンの囲みは一切含めないでください。純粋なJSON配列のみを返してください。`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            let rawText = response.text.trim();
            // 万が一のマークダウンを力技で剥ぎ取る
            if (rawText.startsWith("```")) {
                rawText = rawText.replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
            }

            roomState.quizzes = JSON.parse(rawText);
            roomState.currentQuizIndex = 0;
            roomState.isGameOverPending = false;
            
            for (let id in roomState.players) {
                roomState.players[id].currentScore = 0;
                roomState.gameWrongCounts[id] = 0;
                roomState.isDisqualified[id] = false;
            }
            startQuizRound();

        } catch (error) {
            console.error("AI生成エラー:", error);
            io.emit('host-override-notice', "❌ クイズ生成に失敗しました。もう一度開始ボタンを押してください。");
            roomState.status = 'LOBBY';
            io.emit('room-update', roomState);
        }
    });

    function startQuizRound() {
        clearInterval(roomState.textTimer);
        clearInterval(roomState.answerTimer);
        clearInterval(roomState.thinkingTimer);

        roomState.status = 'QUIZ_TEXT';
        roomState.activePlayerId = null;
        roomState.wrongCountsInRound = {};
        roomState.roundAnswersLog = [];
        roomState.displayedTextLength = 0;

        io.emit('quiz-start', { index: roomState.currentQuizIndex });
        io.emit('room-update', roomState);

        const fullQuestionText = roomState.quizzes[roomState.currentQuizIndex].question;
        
        // 文字送り（スクロールタイピング演出）の再実装
        roomState.textTimer = setInterval(() => {
            roomState.displayedTextLength++;
            const currentChunk = fullQuestionText.substring(0, roomState.displayedTextLength);
            io.emit('quiz-text-chunk', { text: currentChunk });

            if (roomState.displayedTextLength >= fullQuestionText.length) {
                clearInterval(roomState.textTimer);
                startThinkingTimer(); // 読み上げ終了後の猶予タイマーへ
            }
        }, 120); // 1文字0.12秒ペース
    }

    // 読み上げ終了後のシンキングタイマー
    function startThinkingTimer() {
        let countdown = roomState.config.thinkingLimit;
        io.emit('thinking-timer', countdown);

        roomState.thinkingTimer = setInterval(() => {
            countdown--;
            io.emit('thinking-timer', countdown);

            if (countdown <= 0) {
                clearInterval(roomState.thinkingTimer);
                // 誰も押さずにスルー（タイムアウト）
                goToResultView(null, "(誰も押さずに時間切れ)", roomState.quizzes[roomState.currentQuizIndex]);
            }
        }, 1000);
    }

    // BUZZボタン（早押し検知）
    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        if (roomState.isDisqualified[socket.id]) return;
        if ((roomState.wrongCountsInRound[socket.id] || 0) >= roomState.config.wrongLimit) return;

        // 文字送りとシンキングタイマーを即座に「静止」
        clearInterval(roomState.textTimer);
        clearInterval(roomState.thinkingTimer);

        roomState.status = 'QUIZ_ANSWER';
        roomState.activePlayerId = socket.id;
        io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });
        io.emit('room-update', roomState);

        // 回答入力の制限時間タイマー
        let countdown = roomState.config.answerLimit;
        io.emit('answer-timer', countdown);

        roomState.answerTimer = setInterval(() => {
            countdown--;
            io.emit('answer-timer', countdown);

            if (countdown <= 0) {
                clearInterval(roomState.answerTimer);
                // 解答タイムアウト＝誤答扱い
                submitAnswerProcess("");
            }
        }, 1000);
    });

    socket.on('submit-answer', (answerText) => {
        if (roomState.status !== 'QUIZ_ANSWER' || socket.id !== roomState.activePlayerId) return;
        clearInterval(roomState.answerTimer);
        submitAnswerProcess(answerText);
    });

    function submitAnswerProcess(answerText) {
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        const isCorrect = checkAnswer(answerText, quiz.answers);
        const pid = roomState.activePlayerId;
        const pName = roomState.players[pid].name;

        roomState.roundAnswersLog.push({ playerId: pid, name: pName, text: answerText || "(タイムアウト)", isCorrect: isCorrect });

        if (isCorrect) {
            roomState.players[pid].currentScore += roomState.config.plusScore;
            roomState.players[pid].totalScore += roomState.config.plusScore;

            if (roomState.players[pid].currentScore >= roomState.config.winScore) {
                roomState.isGameOverPending = true;
            }
            goToResultView(isCorrect, answerText, quiz);
        } else {
            roomState.players[pid].currentScore -= roomState.config.minusScore;
            roomState.players[pid].totalScore -= roomState.config.minusScore;
            roomState.wrongCountsInRound[pid] = (roomState.wrongCountsInRound[pid] || 0) + 1;
            roomState.gameWrongCounts[pid] = (roomState.gameWrongCounts[pid] || 0) + 1;

            if (roomState.gameWrongCounts[pid] >= roomState.config.gameWrongLimit) {
                roomState.isDisqualified[pid] = true;
                io.emit('host-override-notice', `🚨 ${pName} さんが累計お手つき上限で【失格】となりました！`);
            }

            const totalPlayers = Object.keys(roomState.players);
            const alivePlayers = totalPlayers.filter(id => !roomState.isDisqualified[id] && (roomState.wrongCountsInRound[id] || 0) < roomState.config.wrongLimit);

            // 他に解答できる人がいて、続行設定なら問題の文字送りを再開
            if (roomState.config.continueOnWrong && alivePlayers.length > 0) {
                io.emit('wrong-mid-quiz', { wrongPlayer: pName, answerText });
                roomState.status = 'QUIZ_TEXT';
                io.emit('room-update', roomState);

                // 文字送り再開
                const fullQuestionText = quiz.question;
                roomState.textTimer = setInterval(() => {
                    roomState.displayedTextLength++;
                    const currentChunk = fullQuestionText.substring(0, roomState.displayedTextLength);
                    io.emit('quiz-text-chunk', { text: currentChunk });

                    if (roomState.displayedTextLength >= fullQuestionText.length) {
                        clearInterval(roomState.textTimer);
                        startThinkingTimer();
                    }
                }, 120);
            } else {
                // 生存者全滅、または続行しない場合
                const querySurvivers = totalPlayers.filter(id => !roomState.isDisqualified[id]);
                if (querySurvivers.length === 0) {
                    roomState.isGameOverPending = true;
                }
                goToResultView(isCorrect, answerText, quiz);
            }
        }
    }

    function goToResultView(isCorrect, answerText, quiz) {
        roomState.status = 'QUIZ_RESULT';
        roomState.confirmedPlayers = {};
        io.emit('quiz-round-result', {
            isCorrect, answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
            answerText, correctAnswer: quiz.answers[0], explanation: quiz.explanation, fullQuestion: quiz.question,
            answersLog: roomState.roundAnswersLog
        });
        io.emit('room-update', roomState);
    }

    socket.on('confirm-next', () => {
        roomState.confirmedPlayers[socket.id] = true;
        io.emit('confirm-update', roomState.confirmedPlayers);

        const totalPlayersCount = Object.keys(roomState.players).length;
        const confirmedCount = Object.keys(roomState.confirmedPlayers).length;

        if (confirmedCount >= totalPlayersCount) {
            if (roomState.isGameOverPending) {
                triggerGameOver();
                return;
            }

            roomState.currentQuizIndex++;
            if (roomState.currentQuizIndex >= roomState.quizzes.length) {
                triggerGameOver();
            } else {
                startQuizRound();
            }
        }
    });

    function triggerGameOver() {
        roomState.status = 'GAME_OVER';
        io.emit('room-update', roomState);
        io.emit('game-over', roomState.players);
    }

    // ホストコントロール（判定上書き・ロビー戻る・キック・譲渡）
    socket.on('host-control', (data) => {
        if (socket.id !== roomState.hostId) return;

        // 1. 判定の上書き
        if (data.action === 'override-log-status') {
            const targetPid = data.playerId;
            const targetLogIndex = data.logIndex;
            const newStatus = data.newStatus;
            const logItem = roomState.roundAnswersLog[targetLogIndex];
            if (!logItem) return;

            const currentStatus = logItem.isCorrect === true ? 'correct' : (logItem.isCorrect === false ? 'wrong' : 'nocount');
            if (newStatus === currentStatus) return;

            if (currentStatus === 'correct') {
                roomState.players[targetPid].currentScore -= roomState.config.plusScore;
            } else if (currentStatus === 'wrong') {
                roomState.players[targetPid].currentScore += roomState.config.minusScore;
                roomState.gameWrongCounts[targetPid] = Math.max(0, (roomState.gameWrongCounts[targetPid] || 0) - 1);
                if (roomState.gameWrongCounts[targetPid] < roomState.config.gameWrongLimit) roomState.isDisqualified[targetPid] = false;
            }

            if (newStatus === 'correct') {
                roomState.players[targetPid].currentScore += roomState.config.plusScore;
                logItem.isCorrect = true;
            } else if (newStatus === 'wrong') {
                roomState.players[targetPid].currentScore -= roomState.config.minusScore;
                logItem.isCorrect = false;
                roomState.gameWrongCounts[targetPid]++;
                if (roomState.gameWrongCounts[targetPid] >= roomState.config.gameWrongLimit) roomState.isDisqualified[targetPid] = true;
            } else if (newStatus === 'nocount') {
                logItem.isCorrect = null;
            }

            const totalPlayers = Object.keys(roomState.players);
            const hasWinner = totalPlayers.some(id => roomState.players[id].currentScore >= roomState.config.winScore);
            const hasSurvivers = totalPlayers.some(id => !roomState.isDisqualified[id]);
            roomState.isGameOverPending = hasWinner || !hasSurvivers;

            io.emit('quiz-round-result', {
                isCorrect: roomState.roundAnswersLog[roomState.roundAnswersLog.length - 1].isCorrect,
                answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
                answerText: roomState.roundAnswersLog[roomState.roundAnswersLog.length - 1].text,
                correctAnswer: roomState.quizzes[roomState.currentQuizIndex].answers[0],
                explanation: roomState.quizzes[roomState.currentQuizIndex].explanation,
                fullQuestion: roomState.quizzes[roomState.currentQuizIndex].question,
                answersLog: roomState.roundAnswersLog
            });
            io.emit('room-update', roomState);
        }
        // 2. ロビーへ戻る
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
        // ★追加機能1：プレイヤーキック
        else if (data.action === 'kick-player') {
            const targetId = data.targetId;
            if (targetId && roomState.players[targetId] && targetId !== roomState.hostId) {
                const targetName = roomState.players[targetId].name;
                io.to(targetId).emit('kicked-notice', "🚨 あなたはホストによってキックされました。");
                
                // ソケット側で強制切断
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.disconnect();
                
                io.emit('host-override-notice', `👋 ${targetName} さんが退出させられました。`);
            }
        }
        // ★追加機能2：ホスト権限譲渡
        else if (data.action === 'transfer-host') {
            const targetId = data.targetId;
            if (targetId && roomState.players[targetId] && targetId !== roomState.hostId) {
                roomState.hostId = targetId;
                io.emit('host-override-notice', `👑 ${roomState.players[targetId].name} さんにホスト権限（ルームマスター）が譲渡されました！`);
                io.emit('room-update', roomState);
            }
        }
    });

    socket.on('disconnect', () => {
        delete roomState.players[socket.id];
        delete roomState.gameWrongCounts[socket.id];
        delete roomState.isDisqualified[socket.id];
        if (roomState.hostId === socket.id) {
            roomState.hostId = Object.keys(roomState.players)[0] || null;
            if (roomState.hostId) {
                io.emit('host-override-notice', `👑 前のホストが切断したため、${roomState.players[roomState.hostId].name} さんに権限が移動しました。`);
            }
        }
        io.emit('room-update', roomState);
    });
});

http.listen(3000, () => { console.log('Quiz Server Running on port 3000'); });
