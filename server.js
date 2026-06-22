const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

let roomState = {
    status: 'LOBBY',
    hostId: null,
    config: { 
        genre: '一般', difficulty: '中級', keyword: '', count: 5,
        continueOnWrong: true, wrongLimit: 2, gameWrongLimit: 3, winScore: 30,
        answerLimit: 10, thinkingLimit: 7, plusScore: 10, minusScore: 5            
    },
    players: {}, quizzes: [], currentQuizIndex: 0, activePlayerId: null,
    wrongCountsInRound: {},      
    confirmedPlayers: {},
    roundAnswersLog: [],
    gameWrongCounts: {}, 
    isDisqualified: {},
    isGameOverPending: false
};

// クイズデータのダミー（実際はお使いのAI生成ロジックが入ります）
const mockQuizzes = [
    { question: "日本の首都はどこでしょう？", answers: ["東京", "とうきょう"], explanation: "日本の首都は東京です。" },
    { question: "世界で一番高い山はどこでしょう？", answers: ["エベレスト", "えべれすと"], explanation: "エベレストは標高8848mです。" },
    { question: "リンゴの果皮の一般的な色は何色でしょう？", answers: ["赤", "あか"], explanation: "一般的なリンゴは赤色です。" },
    { question: "日本の国鳥は何でしょう？", answers: ["キジ", "きじ"], explanation: "昭和22年にキジが国鳥に選ばれました。" },
    { question: "水分子の化学式は何でしょう？", answers: ["H2O", "h2o"], explanation: "水素2、酸素1で構成されます。" }
];

io.on('connection', (socket) => {
    const name = socket.handshake.query.name || "名無し";
    
    // 初入室処理
    if (!roomState.hostId) roomState.hostId = socket.id;
    roomState.players[socket.id] = { id: socket.id, name: name, currentScore: 0, totalScore: 0 };
    roomState.gameWrongCounts[socket.id] = 0;
    roomState.isDisqualified[socket.id] = false;

    io.emit('room-update', roomState);

    // ★修正：最も安全にした設定反映ロジック
    socket.on('set-config', (newConfig) => {
        if (socket.id !== roomState.hostId) return;

        // 値をパース（万が一フロントから送られなくてもデフォルト値を死守）
        roomState.config.genre = String(newConfig.genre || '一般');
        roomState.config.keyword = String(newConfig.keyword || '');
        roomState.config.difficulty = String(newConfig.difficulty || '中級');
        roomState.config.count = parseInt(newConfig.count) || 5;
        roomState.config.continueOnWrong = newConfig.continueOnWrong === true;
        roomState.config.wrongLimit = parseInt(newConfig.wrongLimit) || 2;
        roomState.config.winScore = parseInt(newConfig.winScore) || 30; // 確実に反映
        roomState.config.gameWrongLimit = parseInt(newConfig.gameWrongLimit) || 3; // 確実に反映
        roomState.config.answerLimit = parseInt(newConfig.answerLimit) || 10;
        roomState.config.thinkingLimit = parseInt(newConfig.thinkingLimit) || 7;
        roomState.config.plusScore = parseInt(newConfig.plusScore) || 10;
        roomState.config.minusScore = parseInt(newConfig.minusScore) || 5;

        console.log('設定が確定しました:', roomState.config);

        // トースト用の電波をブロードキャスト（確実に実行）
        io.emit('config-saved', `⚙️ ゲーム設定が更新されました！（${roomState.config.winScore}点先取 / 失格${roomState.config.gameWrongLimit}回）`);
        io.emit('room-update', roomState);
    });

    // ゲーム開始ボタン
    socket.on('game-start', () => {
        if (socket.id !== roomState.hostId) return;
        io.emit('generating-quizzes', "🤖 クイズを生成しています。少々お待ちください...");
        
        // テスト用にモックを使用（AI接続時はここに置き換えてください）
        setTimeout(() => {
            roomState.quizzes = mockQuizzes;
            roomState.currentQuizIndex = 0;
            roomState.isGameOverPending = false;
            
            // スコアとお手つきのリセット
            for (let id in roomState.players) {
                roomState.players[id].currentScore = 0;
                roomState.gameWrongCounts[id] = 0;
                roomState.isDisqualified[id] = false;
            }
            startQuizRound();
        }, 1500);
    });

    function startQuizRound() {
        roomState.status = 'QUIZ_TEXT';
        roomState.activePlayerId = null;
        roomState.wrongCountsInRound = {};
        roomState.roundAnswersLog = [];
        io.emit('quiz-start', { index: roomState.currentQuizIndex });
        io.emit('room-update', roomState);
        
        // 簡易テキストchunkシミュレート
        let fullText = roomState.quizzes[roomState.currentQuizIndex].question;
        io.emit('quiz-text-chunk', { text: fullText });
    }

    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        if (roomState.isDisqualified[socket.id]) return;
        if ((roomState.wrongCountsInRound[socket.id] || 0) >= roomState.config.wrongLimit) return;

        roomState.status = 'QUIZ_ANSWER';
        roomState.activePlayerId = socket.id;
        io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });
        io.emit('room-update', roomState);
    });

    socket.on('submit-answer', (answerText) => {
        if (roomState.status !== 'QUIZ_ANSWER' || socket.id !== roomState.activePlayerId) return;

        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        const isCorrect = quiz.answers.includes(answerText);
        const pid = socket.id;
        const pName = roomState.players[pid].name;

        roomState.roundAnswersLog.push({ playerId: pid, name: pName, text: answerText || "(空欄)", isCorrect: isCorrect });

        if (isCorrect) {
            roomState.players[pid].currentScore += roomState.config.plusScore;
            roomState.players[pid].totalScore += roomState.config.plusScore;

            // ★先取ポイントチェック：この段階では pending フラグを立てるだけ（続行させない準備）
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

            if (roomState.config.continueOnWrong && alivePlayers.length > 0) {
                io.emit('wrong-mid-quiz', { wrongPlayer: pName, answerText });
                roomState.status = 'QUIZ_TEXT';
                io.emit('room-update', roomState);
            } else {
                const querySurvivers = totalPlayers.filter(id => !roomState.isDisqualified[id]);
                if (querySurvivers.length === 0) {
                    roomState.isGameOverPending = true;
                }
                goToResultView(isCorrect, answerText, quiz);
            }
        }
    });

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

    // ★重要：全員が「確認ボタン」を押し終えたあとの画面遷移判定
    socket.on('confirm-next', () => {
        roomState.confirmedPlayers[socket.id] = true;
        io.emit('confirm-update', roomState.confirmedPlayers);

        const totalPlayersCount = Object.keys(roomState.players).length;
        const confirmedCount = Object.keys(roomState.confirmedPlayers).length;

        if (confirmedCount >= totalPlayersCount) {
            // ポイント先取、または全員失格でフラグが立っていた場合、ここで初めてGAME_OVERへ遷移！
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
        io.emit('game-over', roomState.players); // 全プレイヤーの最終成績を送る
    }

    // ホストコントロール（上書き・ロビー戻る）
    socket.on('host-control', (data) => {
        if (socket.id !== roomState.hostId) return;

        if (data.action === 'override-log-status') {
            const targetPid = data.playerId;
            const targetLogIndex = data.logIndex;
            const newStatus = data.newStatus;
            const logItem = roomState.roundAnswersLog[targetLogIndex];
            if (!logItem) return;

            const currentStatus = logItem.isCorrect === true ? 'correct' : (logItem.isCorrect === false ? 'wrong' : 'nocount');
            if (newStatus === currentStatus) return;

            // スコアロールバック
            if (currentStatus === 'correct') {
                roomState.players[targetPid].currentScore -= roomState.config.plusScore;
            } else if (currentStatus === 'wrong') {
                roomState.players[targetPid].currentScore += roomState.config.minusScore;
                roomState.gameWrongCounts[targetPid] = Math.max(0, (roomState.gameWrongCounts[targetPid] || 0) - 1);
                if (roomState.gameWrongCounts[targetPid] < roomState.config.gameWrongLimit) roomState.isDisqualified[targetPid] = false;
            }

            // 新判定
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

            // 先取の再判定
            const totalPlayers = Object.keys(roomState.players);
            const hasWinner = totalPlayers.some(id => roomState.players[id].currentScore >= roomState.config.winScore);
            const hasSurvivers = totalPlayers.some(id => !roomState.isDisqualified[id]);
            roomState.isGameOverPending = hasWinner || !hasSurvivers;

            // クライアントを再描画
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
        else if (data.action === 'return-to-lobby') {
            // ★修正：ロビーに戻ったときに全てを初期化
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

    socket.on('disconnect', () => {
        delete roomState.players[socket.id];
        if (roomState.hostId === socket.id) {
            roomState.hostId = Object.keys(roomState.players)[0] || null;
        }
        io.emit('room-update', roomState);
    });
});

http.listen(3000, () => { console.log('Server running on port 3000'); });
