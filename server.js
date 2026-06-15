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

// クイズのキャッシュ用ファイルパス
const CACHE_FILE_PATH = path.join(__dirname, 'quizzes_cache.json');

// 初期状態で最低限持っておくデフォルトのバックアップクイズ
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
    config: { genre: '一般', difficulty: '中級', count: 5 },
    players: {}, // 各プレイヤー: { id, name, currentScore, totalScore }
    quizzes: [],
    currentQuizIndex: 0,
    activePlayerId: null,
    textTimer: null,
    answerTimer: null,
    displayedTextLength: 0
};

// --- Gemini API & クイズ自動生成・キャッシュ管理ロジック ---
async function generateQuizzes(config) {
    // 1. Gemini APIによる動的生成を試みる
    // Renderの設定画面(Environment)で GEMINI_API_KEY を登録しておけば自動で有効化されます
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
        try {
            console.log("Gemini API を使用してクイズを生成中...");
            const ai = new GoogleGenAI({ apiKey: apiKey });
            
            const prompt = `
            ジャンル: ${config.genre}
            難易度: ${config.difficulty}
            問題数: ${config.count}
            上記条件に合う早押しクイズを、以下のJSONフォーマットの配列のみで出力してください。Markdownの枠（\`\`\`json等）や余計な解説文は一切含めず、純粋なJSON文字列だけを返してください。
            [
              {
                "question": "問題文",
                "answers": ["正解", "ひらがな正解", "別解"],
                "explanation": "解説文"
              }
            ]`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash', // 2026年現在の超高速・標準モデル
                contents: prompt,
            });

            const text = response.text.trim();
            // 万が一AIがMarkdownの枠を付けてしまった場合のトリミング
            const jsonString = text.replace(/^```json/, '').replace(/```$/, '').trim();
            const newQuizzes = JSON.parse(jsonString);

            // ジャンルと難易度を付与してキャッシュに保存
            const quizzesWithMeta = newQuizzes.map(q => ({
                ...q,
                genre: config.genre,
                difficulty: config.difficulty
            }));

            saveQuizzesToCache(quizzesWithMeta);
            return quizzesWithMeta;

        } catch (error) {
            console.error("Gemini API でエラーが発生しました。キャッシュデータを探します:", error);
        }
    } else {
        console.log("GEMINI_API_KEY が設定されていないため、キャッシュデータから取得します。");
    }

    // 2. Geminiが使えない、または未設定の場合はローカルキャッシュから条件に合うものを探す
    const cachedData = loadQuizzesFromCache();
    const filtered = cachedData.filter(q => q.genre === config.genre && q.difficulty === config.difficulty);

    if (filtered.length >= config.count) {
        console.log(`キャッシュから条件に合うクイズを ${config.count} 問再利用します。`);
        // ランダムにシャッフルして指定数取り出す
        return filtered.sort(() => 0.5 - Math.random()).slice(0, config.count);
    }

    // 3. キャッシュにもデータが足りない場合はデフォルトデータを使用する（最終フォールバック）
    console.log("キャッシュにも十分なデータがないため、デフォルトのバックアップデータを使用します。");
    return DEFAULT_QUIZZES;
}

// キャッシュファイルから読み込み
function loadQuizzesFromCache() {
    try {
        if (fs.existsSync(CACHE_FILE_PATH)) {
            const data = fs.readFileSync(CACHE_FILE_PATH, 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("キャッシュの読み込みに失敗しました:", e);
    }
    return [...DEFAULT_QUIZZES];
}

// キャッシュファイルへ保存（重複を避けて追加）
function saveQuizzesToCache(newQuizzes) {
    try {
        let currentCache = loadQuizzesFromCache();
        // 既存の問題文と重複していないものだけを追加
        newQuizzes.forEach(newQ => {
            if (!currentCache.some(cacheQ => cacheQ.question === newQ.question)) {
                currentCache.push(newQ);
            }
        });
        fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(currentCache, null, 2), 'utf-8');
        console.log(`現在合計 ${currentCache.length} 問のクイズが蓄積されています。`);
    } catch (e) {
        console.error("キャッシュの保存に失敗しました:", e);
    }
}

// --- 表記ゆれ・正誤判定 ---
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
    const nickname = socket.handshake.query.name || `ゲスト_${socket.id.slice(0,4)}`;
    console.log(`ユーザー接続: ${nickname} (${socket.id})`);
    
    // スコア構造の変更: currentScore（今ゲーム） と totalScore（総合）
    roomState.players[socket.id] = { 
        id: socket.id, 
        name: nickname, 
        currentScore: 0, 
        totalScore: 0 
    };
    io.emit('room-update', roomState);

    socket.on('set-config', (config) => {
        if (roomState.status !== 'LOBBY') return;
        roomState.config = config;
        io.emit('room-update', roomState);
    });

    socket.on('game-start', async () => {
        if (roomState.status !== 'LOBBY') return;
        
        // ゲーム開始時に「現在のゲーム内の点数」だけ全員リセット
        Object.keys(roomState.players).forEach(id => {
            roomState.players[id].currentScore = 0;
        });

        roomState.quizzes = await generateQuizzes(roomState.config);
        roomState.currentQuizIndex = 0;
        startQuizRound();
    });

    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT') return;
        
        clearTimeout(roomState.textTimer);
        clearInterval(roomState.textTimer);

        roomState.status = 'QUIZ_ANSWER';
        roomState.activePlayerId = socket.id;
        
        io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });
        io.emit('room-update', roomState);

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
            // 今ゲームの点数と、総合点数の両方に加算
            roomState.players[roomState.activePlayerId].currentScore += 10;
            roomState.players[roomState.activePlayerId].totalScore += 10;
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
    io.emit('room-update', roomState);

    roomState.textTimer = setInterval(() => {
        roomState.displayedTextLength++;
        const currentText = quiz.question.substring(0, roomState.displayedTextLength);
        io.emit('quiz-text-chunk', { text: currentText });

        if (roomState.displayedTextLength >= quiz.question.length) {
            clearInterval(roomState.textTimer);

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
