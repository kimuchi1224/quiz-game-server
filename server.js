const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const levenshtein = require('fast-levenshtein');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

let roomState = {
    status: 'LOBBY',
    config: { genre: '一般', difficulty: '中級', count: 5 },
    players: {},
    quizzes: [],
    currentQuizIndex: 0,
    activePlayerId: null,
    textTimer: null,
    answerTimer: null,
    displayedTextLength: 0
};

async function generateQuizzes(config) {
    return [
        {
            question: "日本の現在の首都であり、世界最大の人口を有する都市はどこでしょう？",
            answers: ["東京", "とうきょう", "tokyo", "東京都"],
            explanation: "日本の事実上の首都は東京都です。江戸時代までは京都が中心でした。"
        },
        {
            question: "吾輩は猫である、坊っちゃんなどの名作を残した日本を代表する文豪は誰でしょう？",
            answers: ["夏目漱石", "なつめそーせき", "なつめそうせき", "夏目金之助"],
            explanation: "夏目漱石の本名は夏目金之助。千円札の肖像画にもなりました。"
        }
    ];
}

function checkAnswer(input, validAnswers) {
    const normalizedInput = input.trim().toLowerCase().replace(/\s+/g, '');
    for (let answer of validAnswers) {
        const normalizedAnswer = answer.trim().toLowerCase().replace(/\s+/g, '');
        if (normalizedInput === normalizedAnswer) return true;
        const distance = levenshtein.get(normalizedInput, normalizedAnswer);
        if (normalizedAnswer.length >= 4 && distance <= 1) return true;
    }
    return false;
}

io.on('connection', (socket) => {
    // クライアントから送られたニックネームを取得
    const nickname = socket.handshake.query.name || `ゲスト_${socket.id.slice(0,4)}`;
    console.log(`ユーザー接続: ${nickname} (${socket.id})`);
    
    roomState.players[socket.id] = { id: socket.id, name: nickname, score: 0 };
    io.emit('room-update', roomState);

    socket.on('set-config', (config) => {
        if (roomState.status !== 'LOBBY') return;
        roomState.config = config;
        io.emit('room-update', roomState);
    });

    socket.on('game-start', async () => {
        if (roomState.status !== 'LOBBY') return;
        roomState.quizzes = await generateQuizzes(roomState.config);
        roomState.currentQuizIndex = 0;
        startQuizRound();
    });

    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        
        // 文字送りタイマー（またはスルー用タイマー）を即座に停止
        clearTimeout(roomState.textTimer);
        clearInterval(roomState.textTimer);

        roomState.status = 'QUIZ_ANSWER';
        roomState.activePlayerId = socket.id;
        
        io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });
        io.emit('room-update', roomState); // 画面遷移用に状態を通知

        let countdown = 10;
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

    socket.on('submit-answer', (answerText) => {
        if (roomState.status !== 'QUIZ_ANSWER' || roomState.activePlayerId !== socket.id) return;
        clearInterval(roomState.answerTimer);
        submitAnswer(answerText);
    });

    function submitAnswer(answerText) {
        const quiz = roomState.quizzes[roomState.currentQuizIndex];
        const isCorrect = checkAnswer(answerText, quiz.answers);
        
        if (isCorrect && roomState.activePlayerId) {
            roomState.players[roomState.activePlayerId].score += 10;
        }

        roomState.status = 'QUIZ_RESULT';
        io.emit('quiz-round-result', {
            isCorrect,
            answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
            answerText: answerText,
            correctAnswer: quiz.answers[0],
            explanation: quiz.explanation
        });
        io.emit('room-update', roomState);

        setTimeout(() => {
            roomState.currentQuizIndex++;
            if (roomState.currentQuizIndex < roomState.quizzes.length) {
                startQuizRound();
            } else {
                roomState.status = 'LOBBY';
                // ゲーム終了時にスコアをリセットしたい場合はここで処理
                io.emit('game-over', roomState.players);
                io.emit('room-update', roomState);
            }
        }, 7000);
    }

    socket.on('disconnect', () => {
        console.log(`ユーザー切断: ${roomState.players[socket.id]?.name}`);
        delete roomState.players[socket.id];
        io.emit('room-update', roomState);
    });
});

function startQuizRound() {
    roomState.status = 'QUIZ_TEXT';
    roomState.activePlayerId = null;
    roomState.displayedTextLength = 0;
    const quiz = roomState.quizzes[roomState.currentQuizIndex];

    io.emit('quiz-start', { index: roomState.currentQuizIndex });
    io.emit('room-update', roomState); // QUIZ_TEXTへ画面遷移

    roomState.textTimer = setInterval(() => {
        roomState.displayedTextLength++;
        const currentText = quiz.question.substring(0, roomState.displayedTextLength);
        io.emit('quiz-text-chunk', { text: currentText });

        if (roomState.displayedTextLength >= quiz.question.length) {
            clearInterval(roomState.textTimer);

            // 問題文が流れた後、誰も押さなかった場合の7秒タイムアウト処理
            roomState.textTimer = setTimeout(() => {
                roomState.status = 'QUIZ_RESULT';
                io.emit('quiz-round-result', {
                    isCorrect: false,
                    answeredPlayer: "なし",
                    answerText: "(タイムアップ)",
                    correctAnswer: quiz.answers[0],
                    explanation: quiz.explanation
                });
                io.emit('room-update', roomState);

                setTimeout(() => {
                    roomState.currentQuizIndex++;
                    if (roomState.currentQuizIndex < roomState.quizzes.length) {
                        startQuizRound();
                    } else {
                        roomState.status = 'LOBBY';
                        io.emit('game-over', roomState.players);
                        io.emit('room-update', roomState);
                    }
                }, 7000);
            }, 7000);
        }
    }, 150);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
