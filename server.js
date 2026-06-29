const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let roomState = {
    status: 'LOBBY',
    hostId: null,
    config: { 
        genre: '一般', difficulty: '中級', keyword: '', count: 5,
        continueOnWrong: true, wrongLimit: 2, gameWrongLimit: 3, winScore: 30,
        answerLimit: 10, thinkingLimit: 7, plusScore: 10, minusScore: 5,
        isImageMode: false // ★新規：画像クイズモードフラグ
    },
    players: {}, 
    isReady: {}, // ★新規：プレイヤーの準備完了状態管理
    quizzes: [], currentQuizIndex: 0, activePlayerId: null,
    textTimer: null, answerTimer: null, thinkingTimer: null, displayedTextLength: 0,
    wrongCountsInRound: {},      
    confirmedPlayers: {},
    roundAnswersLog: [],
    gameWrongCounts: {}, 
    isDisqualified: {},
    isGameOverPending: false,
    buzzWindowOpen: false,
    firstBuzzTime: 0,
    buzzSessionIndex: 0,
    roundBuzzLog: []
};

function checkAnswer(userAns, correctAnswers) {
    if (!userAns) return false;
    const normalize = (str) => {
        return str.trim().toLowerCase()
            .replace(/[\u30a1-\u30f6]/g, match => String.fromCharCode(match.charCodeAt(0) - 0x60))
            .replace(/[\uFF01-\uFF5E]/g, match => String.fromCharCode(match.charCodeAt(0) - 0xfee0))
            .replace(/[ーｰ➖━]/g, '').replace(/[\s ]/g, '');
    };
    const normUser = normalize(userAns);
    return correctAnswers.some(ans => {
        const normAns = normalize(ans);
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
    roomState.isReady[socket.id] = false; // 初期状態は未準備

    io.emit('room-update', roomState);

    // ★新規：Ready状態の切り替え
    socket.on('toggle-ready', () => {
        if (socket.id === roomState.hostId) return; // ホストはReady不要
        roomState.isReady[socket.id] = !roomState.isReady[socket.id];
        io.emit('room-update', roomState);
    });

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
        roomState.config.isImageMode = newConfig.isImageMode === true; // 追加

        io.emit('config-saved', `⚙️ ゲーム設定が更新されました！`);
        io.emit('room-update', roomState);
    });

    socket.on('game-start', async () => {
        if (socket.id !== roomState.hostId) return;
        
        // 全員Readyかチェック（ホスト以外のプレイヤー全員）
        const guestIds = Object.keys(roomState.players).filter(id => id !== roomState.hostId);
        const allReady = guestIds.every(id => roomState.isReady[id] === true);
        if (guestIds.length > 0 && !allReady) {
            socket.emit('host-override-notice', "⚠️ まだ準備完了していないプレイヤーがいます。");
            return;
        }

        io.emit('generating-quizzes', "🤖 Gemini AIが特別クイズセットを編集中...");

        try {
            // ★新規：通常モードと画像モードでプロンプトを切り替え
            let modePrompt = "";
            if (roomState.config.isImageMode) {
                modePrompt = `【超重要：今回は「視覚・画像連想クイズ」です】
                問題文の冒頭に、必ずそのお題を表す分かりやすい「アスキーアート(AA)」や「■や○で描いたドット絵、絵文字を組み合わせた視覚的アート」を3〜5行程度で挿入してください。
                その上で、文章として「これは何を表した画像（絵）でしょう？」「この形状を持つ、◯◯といえば何でしょう？」という形式で早押し問題文を作成してください。`;
            } else {
                modePrompt = `
                - 問題文は「限定要素（パラレル要素）」を意識し、文章が進むにつれて徐々に絞り込まれる構造にしてください。
                - 「最初の一文で一意に特定できるコアな情報」から始まり、「中盤でヒントが増え」、「終盤で確定する」というグラデーションを意識してください。
                - 誤読を誘うような悪意のある引っ掛け問題は避け、純粋な知識と推認力で競える構成にしてください。
                - 問題文は合計50～80文字で構成し、疑問形で表現してください。
                `;
            }

            const prompt = `
                # 役割設定
                - あなたは「一流のクイズ作家」であり、同時に「厳格なファクトチェッカー」です。
                - エンターテインメントとして面白く、かつ学術的・歴史的な事実に基づいた「正確で質の高い早押しクイズ」を作成してください。
                
                # 目的
                - 末尾の【作成条件】に従い、指定された条件を満たすハイクオリティな早押しクイズ（問題文、解答、解説）を作成してください。
                
                # クイズ作成における必須要件
                - 情報の正確性（確度）の担保
                - 諸説ある事実、最新の研究で否定された学説、不確定なネットの噂などは問題文に含めないでください。
                - 誰が・いつ・どこで検証しても、答えが一つに定まる客観的事実のみを根拠にしてください。
                
                # 早押しクイズとしての構造化（スクリーニング効果）
                ${modePrompt}
                
                # 解答のバリエーション（多様性）と表記揺れ対応
                - 答えの対象（人物、地名、作品名、一般名詞、現象名など）に偏りが出ないよう、バラエティ豊かにしてください。
                - ユーザーが自動採点や柔軟な正誤判定を行えるよう、一般的な呼称、フルネーム、ひらがな、別解などを網羅して出力してください。
                
                # 出力形式に関する絶対ルール
                - 出力は、以下に示す【指定のJSON形式】の仕様に完全に従った、純粋なJSON配列（ valid な JSON ）のみとしてください。
                - **重要**  レスポンスには、\`\`\`json などのマークダウンのコードブロック、解説テキスト、前置き、結びの言葉などを一切含めないでください。 最初の文字は [ で始まり、最後の文字は ] で終わる、純粋なJSONデータのみを出力してください。
                
                【指定のJSON形式】
                [
                  {
                    "question": "問題文",
                    "answers": ["模範解答（漢字や正式名称）", "ひらがな", "別解やカタカナなど表記ゆれ候補"],
                    "explanation": "正解の解説文。なぜこれが確実に正解と言えるのかの理由、および確定根拠を2〜3文で記述"
                  }
                ]
                
                【作成条件】
                問題数: ${roomState.config.count}
                ジャンル: ${roomState.config.genre}
                難易度: ${roomState.config.difficulty}
                キーワード・テーマ: ${roomState.config.keyword || 'なし'}
            `;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            let rawText = response.text.trim();
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
            console.error("生成エラー:", error);
            io.emit('host-override-notice', "❌ クイズ生成に失敗しました。再試行してください。");
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
        
        // 早押し計測初期化
        roomState.buzzWindowOpen = false;
        roomState.firstBuzzTime = 0;
        roomState.buzzSessionIndex = 0;
        roomState.roundBuzzLog = [];

        io.emit('quiz-start', { index: roomState.currentQuizIndex });
        io.emit('room-update', roomState);

        const fullQuestionText = roomState.quizzes[roomState.currentQuizIndex].question;
        
        roomState.textTimer = setInterval(() => {
            roomState.displayedTextLength++;
            const currentChunk = fullQuestionText.substring(0, roomState.displayedTextLength);
            io.emit('quiz-text-chunk', { text: currentChunk });

            if (roomState.displayedTextLength >= fullQuestionText.length) {
                clearInterval(roomState.textTimer);
                startThinkingTimer();
            }
        }, roomState.config.isImageMode ? 50 : 120); // 画像モード（AA含む）の場合は少し早めに文字出し
    }

    function startThinkingTimer() {
        let countdown = roomState.config.thinkingLimit;
        io.emit('thinking-timer', countdown);
        roomState.thinkingTimer = setInterval(() => {
            countdown--;
            io.emit('thinking-timer', countdown);
            if (countdown <= 0) {
                clearInterval(roomState.thinkingTimer);
                goToResultView(null, "(誰も押さずに時間切れ)", roomState.quizzes[roomState.currentQuizIndex]);
            }
        }, 1000);
    }

    socket.on('buzz', () => {
        if (roomState.status !== 'QUIZ_TEXT' && !roomState.buzzWindowOpen) return;
        if (roomState.isDisqualified[socket.id]) return;
        if ((roomState.wrongCountsInRound[socket.id] || 0) >= roomState.config.wrongLimit) return;

        const now = Date.now();
        const currentSession = roomState.buzzSessionIndex;

        // 現在のセッション（仕切り直しターン）で、すでに自分がBUZZしていないかチェック
        // ※ 過去のセッションで押していた場合は、新しいセッションならもう一度押せる
        const alreadyBuzzedInSession = roomState.roundBuzzLog.some(b => b.id === socket.id && b.session === currentSession);
        if (alreadyBuzzedInSession) return;

        // 現在のセッションにおいて「1人目のBUZZ」かどうかを判定
        const isFirstInSession = !roomState.roundBuzzLog.some(b => b.session === currentSession);

        if (isFirstInSession) {
            // 【現在のセッションでの1人目】
            roomState.buzzWindowOpen = true;
            roomState.firstBuzzTime = now;
            roomState.status = 'QUIZ_ANSWER';
            roomState.activePlayerId = socket.id;

            clearInterval(roomState.textTimer);
            clearInterval(roomState.thinkingTimer);

            // セッション情報(session)と、何回目かのBUZZ順(order)を記録
            roomState.roundBuzzLog.push({ 
                id: socket.id, 
                name: roomState.players[socket.id].name, 
                delay: 0,
                session: currentSession,
                order: roomState.roundBuzzLog.length + 1
            });

            io.emit('buzzed', { playerId: socket.id, name: roomState.players[socket.id].name });
            io.emit('room-update', roomState);

            // 1秒間の同時押し受付ウィンドウを開く
            setTimeout(() => {
                roomState.buzzWindowOpen = false;
                console.log("早押し同時押し集計結果:", roomState.roundBuzzLog);
            }, 1000);

            // 解答入力タイマー
            let countdown = roomState.config.answerLimit;
            io.emit('answer-timer', countdown);
            roomState.answerTimer = setInterval(() => {
                countdown--;
                io.emit('answer-timer', countdown);
                if (countdown <= 0) {
                    clearInterval(roomState.answerTimer);
                    submitAnswerProcess("");
                }
            }, 1000);

        } else {
            // 【現在のセッションでの2人目以降（1秒以内の同時押し）】
            const diffTime = ((now - roomState.firstBuzzTime) / 1000).toFixed(3); // セッション1人目からの差分
            roomState.roundBuzzLog.push({
                id: socket.id,
                name: roomState.players[socket.id].name,
                delay: parseFloat(diffTime),
                session: currentSession,
                order: roomState.roundBuzzLog.length + 1
            });
            
            // リアルタイムにホスト画面等へログを同期したい場合はここでemit
            io.emit('room-update', roomState);
        }
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

            if (roomState.config.continueOnWrong && alivePlayers.length > 0) {
                io.emit('wrong-mid-quiz', { wrongPlayer: pName, answerText });
                roomState.status = 'QUIZ_TEXT';
                roomState.buzzWindowOpen = false;
                roomState.firstBuzzTime = 0;
                roomState.buzzSessionIndex += 1;
                io.emit('room-update', roomState);

                const fullQuestionText = quiz.question;
                roomState.textTimer = setInterval(() => {
                    roomState.displayedTextLength++;
                    const currentChunk = fullQuestionText.substring(0, roomState.displayedTextLength);
                    io.emit('quiz-text-chunk', { text: currentChunk });

                    if (roomState.displayedTextLength >= fullQuestionText.length) {
                        clearInterval(roomState.textTimer);
                        startThinkingTimer();
                    }
                }, roomState.config.isImageMode ? 50 : 120);
            } else {
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
            answersLog: roomState.roundAnswersLog,
            buzzLog: roomState.roundBuzzLog // ★同時押しのラグデータをフロントへ同期
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
                answersLog: roomState.roundAnswersLog,
                buzzLog: roomState.roundBuzzLog
            });
            io.emit('room-update', roomState);
        }
        else if (data.action === 'return-to-lobby') {
            roomState.status = 'LOBBY';
            roomState.quizzes = [];
            roomState.currentQuizIndex = 0;
            roomState.isGameOverPending = false;
            for (let id in roomState.players) {
                roomState.players[id].currentScore = 0;
                roomState.gameWrongCounts[id] = 0;
                roomState.isDisqualified[id] = false;
                roomState.isReady[id] = false; // レディ状態もリセット
            }
            io.emit('room-update', roomState);
        }
        else if (data.action === 'kick-player') {
            const targetId = data.targetId;
            if (targetId && roomState.players[targetId] && targetId !== roomState.hostId) {
                const targetName = roomState.players[targetId].name;
                io.to(targetId).emit('kicked-notice', "🚨 あなたはホストによってキックされました。");
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.disconnect();
                io.emit('host-override-notice', `👋 ${targetName} さんが退出させられました。`);
            }
        }
        else if (data.action === 'transfer-host') {
            const targetId = data.targetId;
            if (targetId && roomState.players[targetId] && targetId !== roomState.hostId) {
                roomState.hostId = targetId;
                roomState.isReady[targetId] = false; // 新ホストのReadyフラグを解除
                io.emit('host-override-notice', `👑 ${roomState.players[targetId].name} さんにホスト権限が譲渡されました！`);
                io.emit('room-update', roomState);
            }
        }
    });

    socket.on('disconnect', () => {
        delete roomState.players[socket.id];
        delete roomState.gameWrongCounts[socket.id];
        delete roomState.isDisqualified[socket.id];
        delete roomState.isReady[socket.id];
        if (roomState.hostId === socket.id) {
            roomState.hostId = Object.keys(roomState.players)[0] || null;
            if (roomState.hostId) {
                roomState.isReady[roomState.hostId] = false;
                io.emit('host-override-notice', `👑 ホスト権限が移動しました。`);
            }
        }
        io.emit('room-update', roomState);
    });
});

http.listen(3000, () => { console.log('Quiz Server Running on port 3000'); });
