// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const levenshtein = require('fast-levenshtein');

const app = express();
const server = http.createServer(app);

// CORS（クロスドメイン接続）の許可設定
// Render等にホストする場合、フロントとバックのURLが別々になるため必須です
const io = new Server(server, {
    cors: {
        origin: "*", // 本番ではVercelやGitHub PagesのURLを指定するとセキュアです
        methods: ["GET", "POST"]
    }
});

// ポート番号の変更（Render等の環境変数 PORT に対応させる）
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// ゲームのグローバル状態管理（簡易版: 1ルームのみを想定）
let roomState = {
    status: 'LOBBY', // LOBBY, QUIZ_TEXT, QUIZ_ANSWER, QUIZ_RESULT
    config: { genre: '一般', difficulty: '中級', count: 5 },
    players: {},
    quizzes: [],
    currentQuizIndex: 0,
    activePlayerId: null,
    textTimer: null,
    answerTimer: null,
    displayedTextLength: 0
};

// ダミーの問題生成関数（本来はWeb APIやスクレイピング、LLM API等で動的生成）
async function generateQuizzes(config) {
    // ※ 2026年現在のモダンな実装では、ここでLLM API等（OpenAI/Gemini等）を叩き、
    // 指定されたジャンル・難易度の問題をリアルタイム生成するのがベストです。
    return [
        {
            question: "日本の現在の首都であり、世界最大の人口を有する都市はどこでしょう？",
            answers: ["東京", "とうきょう", "tokyo", "東京都"],
            explanation: "日本の事実上の首都は東京都です。江戸時代までは京都が中心でした。"
        },
        {
            question: "吾輩は猫である、坊っちゃんなどの名作を残した日本を代表する文豪は誰でしょう？",
            answers: ["夏目漱石", "なつめそうせき", "夏目金之助"],
            explanation: "夏目漱石の本名は夏目金之助。千円札の肖像画にもなりました。"
        }
    ];
}

// 表記ゆれ・複数回答の判定ロジック
function checkAnswer(input, validAnswers) {
    const normalizedInput = input.trim().toLowerCase().replace(/\s+/g, '');
    
    for (let answer of validAnswers) {
        const normalizedAnswer = answer.trim().toLowerCase().replace(/\s+/g, '');
        
        // 完全一致、または文字列が短い場合の編集距離(表記ゆれ)を許容
        if (normalizedInput === normalizedAnswer) return true;
        
        const distance = levenshtein.get(normalizedInput, normalizedAnswer);
        if (normalizedAnswer.length >= 4 && distance <= 1) return true; // 4文字以上なら1文字のミスを許容
    }
    return false;
}

io.on('connection', (socket) => {
    console.log(`ユーザー接続: ${socket.id}`);
    roomState.players[socket.id] = { id: socket.id, name: `プレイヤー_${socket.id.slice(0,4)}`, score: 0 };
    io.emit('room-update', roomState);

    // 設定変更
    socket.on('set-config', (config) => {
        if (roomState.status !== 'LOBBY') return;
        roomState.config = config;
        io.emit('room-update', roomState);
    });

    // ゲーム開始
    socket.on('game-start', async () => {
        if (roomState.status !== 'LOBBY') return;
        roomState.quizzes = await generateQuizzes(roomState.config);
        roomState.currentQuizIndex = 0;
        startQuizRound();
    });

    // 早押しボタン
    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        clearInterval(roomState.textTimer);
        roomState.status = 'QUIZ_ANSWER';
        roomState.activePlayerId = socket.id;
        
        io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });

        // 10秒間の回答制限タイマー
        let countdown = 10;
        roomState.answerTimer = setInterval(() => {
            countdown--;
            io.emit('answer-timer', countdown);
            if (countdown <= 0) {
                clearInterval(roomState.answerTimer);
                submitAnswer(""); // 時間切れは空文字
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
        
        if (isCorrect && roomState.activePlayerId) {
            roomState.players[roomState.activePlayerId].score += 10;
        }

        roomState.status = 'QUIZ_RESULT';
        io.emit('quiz-round-result', {
            isCorrect,
            answeredPlayer: roomState.activePlayerId ? roomState.players[roomState.activePlayerId].name : "なし",
            answerText: answerText,
            correctAnswer: quiz.answers[0], // 代表的な正解
            explanation: quiz.explanation
        });
        io.emit('room-update', roomState);

        // 7秒後に次の問題かリザルトへ
        setTimeout(() => {
            roomState.currentQuizIndex++;
            if (roomState.currentQuizIndex < roomState.quizzes.length) {
                startQuizRound();
            } else {
                roomState.status = 'LOBBY'; // 簡易的にロビーに戻す
                io.emit('game-over', roomState.players);
                io.emit('room-update', roomState);
            }
        }, 7000);
    }

    socket.on('disconnect', () => {
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

    // 視覚的な文字送りタイマー (150msごとに1文字送る)
    roomState.textTimer = setInterval(() => {
        roomState.displayedTextLength++;
        const currentText = quiz.question.substring(0, roomState.displayedTextLength);
        io.emit('quiz-text-chunk', { text: currentText });

        if (roomState.displayedTextLength >= quiz.question.length) {
            clearInterval(roomState.textTimer);
            // 全文表示後、誰も押さなければ7秒後に自動で結果表示へ
            // (実戦ではタイムアウト処理をここに追加します)
        }
    }, 150);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
