import { App, LogLevel } from '@slack/bolt';
import type { BlockAction, ButtonAction, SayFn } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { config } from './config';
import { ClaudeExecutor } from './claude-executor';
import type { WaitResult, PendingQuestion, AskUserQuestionItem } from './types';

// メッセージイベントの型定義
interface SlackMessage {
  channel: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

export class SlackClient {
  private app: App;
  private claudeExecutor: ClaudeExecutor;
  private processedEvents: Set<string> = new Set(); // 重複排除用
  private pendingQuestions: Map<string, PendingQuestion> = new Map(); // 質問状態管理

  constructor() {
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    this.claudeExecutor = new ClaudeExecutor();
    this.setupEventHandlers();
    this.setupActionHandlers();
    this.startCleanupTimer();
  }

  private setupEventHandlers(): void {
    this.app.message(async ({ message, say }) => {
      const msg = message as SlackMessage;

      // フィルタリング
      const eventKey = `${msg.channel}-${msg.ts}`;
      if (this.processedEvents.has(eventKey)) return;
      this.processedEvents.add(eventKey);

      if (this.processedEvents.size > 1000) {
        const firstKey = this.processedEvents.values().next().value;
        if (firstKey) this.processedEvents.delete(firstKey);
      }

      if ('subtype' in msg && msg.subtype) return;
      if ('bot_id' in msg) return;
      if (msg.channel !== config.targetChannelId) return;
      if (!msg.text) return;

      const text = msg.text;
      const threadTs = msg.thread_ts || msg.ts;
      const isThreadReply = !!msg.thread_ts;

      try {
        let result: WaitResult;

        if (isThreadReply && this.claudeExecutor.hasSession(threadTs)) {
          result = await this.claudeExecutor.executeResume(text, threadTs);
        } else {
          result = await this.claudeExecutor.executeNew(text, threadTs);
        }

        await this.handleWaitResult(result, say, threadTs);
      } catch (error) {
        console.error('[ERROR]', error);
      }
    });
  }

  private async handleWaitResult(result: WaitResult, say: SayFn, threadTs: string): Promise<void> {
    if (result.type === 'final') {
      await say({ text: result.text, thread_ts: threadTs });
    } else if (result.type === 'ask_user_question') {
      await this.sendQuestionToSlack(say, threadTs, result);
    }
  }

  private async sendQuestionToSlack(
    say: SayFn,
    threadTs: string,
    result: Extract<WaitResult, { type: 'ask_user_question' }>
  ): Promise<void> {
    const { toolUse, sessionId } = result;
    const questions = toolUse.input.questions;

    // pendingQuestionsに保存
    this.pendingQuestions.set(threadTs, {
      threadTs,
      sessionId,
      toolUseId: toolUse.id,
      questions,
      answers: {},
      answerIndices: {},
      confirmed: {},
      createdAt: Date.now(),
    });

    // Block Kitで質問を送信
    const blocks = this.buildQuestionBlocks(questions, threadTs);
    await say({ blocks, thread_ts: threadTs });
  }

  private buildQuestionBlocks(
    questions: AskUserQuestionItem[],
    threadTs: string,
    currentAnswers?: Record<string, string[]>
  ): KnownBlock[] {
    const blocks: KnownBlock[] = [];
    const sanitizedThreadTs = threadTs.replace('.', '_');

    questions.forEach((q, qIndex) => {
      const isMultiSelect = q.multiSelect === true;
      const selectedLabels = currentAnswers?.[q.question] || [];

      // 質問ヘッダー（multiSelectの場合は複数選択可能と表示）
      blocks.push({
        type: 'section',
        block_id: `question_${qIndex}_${sanitizedThreadTs}`,
        text: {
          type: 'mrkdwn',
          text: `*${q.header || '質問'}*${isMultiSelect ? '（複数選択可）' : ''}\n${q.question}`,
        },
      });

      // 選択肢ボタン
      if (q.options && q.options.length > 0) {
        const elements = q.options.map((opt, optIndex) => {
          const isSelected = selectedLabels.includes(opt.label);
          return {
            type: 'button' as const,
            text: {
              type: 'plain_text' as const,
              text: `${isSelected ? '✓ ' : ''}${opt.label}`.substring(0, 75),
              emoji: true,
            },
            action_id: `ask_user_question_${sanitizedThreadTs}_${qIndex}_${optIndex}`,
            value: JSON.stringify({
              threadTs,
              questionIndex: qIndex,
              optionIndex: optIndex,
              label: opt.label,
              isMultiSelect,
              optionCount: q.options?.length || 0,
            }),
            style: isSelected ? ('primary' as const) : undefined,
          };
        });

        blocks.push({
          type: 'actions',
          block_id: `options_${qIndex}_${sanitizedThreadTs}`,
          elements,
        });

        // multiSelectの場合は「選択完了」ボタンを追加
        if (isMultiSelect) {
          blocks.push({
            type: 'actions',
            block_id: `confirm_${qIndex}_${sanitizedThreadTs}`,
            elements: [
              {
                type: 'button' as const,
                text: {
                  type: 'plain_text' as const,
                  text: '選択完了',
                  emoji: true,
                },
                action_id: `ask_confirm_${sanitizedThreadTs}_${qIndex}`,
                value: JSON.stringify({
                  threadTs,
                  questionIndex: qIndex,
                  isMultiSelect: true,
                  optionCount: q.options?.length || 0,
                }),
                style: 'primary' as const,
              },
            ],
          });
        }

        // 選択肢の説明を追加
        const descriptions = q.options
          .filter(opt => opt.description)
          .map((opt, i) => `${i + 1}. *${opt.label}*: ${opt.description}`)
          .join('\n');

        if (descriptions) {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: descriptions,
              },
            ],
          });
        }
      }

      // 質問間の区切り
      if (qIndex < questions.length - 1) {
        blocks.push({ type: 'divider' });
      }
    });

    return blocks;
  }

  private setupActionHandlers(): void {
    // 選択肢ボタンクリックハンドラ
    this.app.action<BlockAction<ButtonAction>>(/^ask_user_question_/, async ({ action, body, ack, say }) => {
      await ack();

      try {
        if (!action.value) {
          console.error('[ACTION] No value in action');
          return;
        }
        const value = JSON.parse(action.value);
        const { threadTs, questionIndex, optionIndex, label, isMultiSelect, optionCount } = value;

        const pending = this.pendingQuestions.get(threadTs);
        if (!pending) {
          console.error(`[ACTION] No pending question for thread: ${threadTs}`);
          return;
        }

        const question = pending.questions[questionIndex];
        if (!question) {
          console.error(`[ACTION] Question not found at index: ${questionIndex}`);
          return;
        }

        if (isMultiSelect) {
          // multiSelect: トグル形式で選択/解除
          const currentLabels = pending.answers[question.question] || [];
          const currentIndices = pending.answerIndices[question.question] || [];

          const labelIndex = currentLabels.indexOf(label);
          if (labelIndex >= 0) {
            // 既に選択済み → 解除
            currentLabels.splice(labelIndex, 1);
            const idxIndex = currentIndices.indexOf(optionIndex);
            if (idxIndex >= 0) currentIndices.splice(idxIndex, 1);
            console.log(`[ACTION] ${threadTs} - Deselected: "${label}" (index: ${optionIndex})`);
          } else {
            // 未選択 → 追加
            currentLabels.push(label);
            currentIndices.push(optionIndex);
            console.log(`[ACTION] ${threadTs} - Selected: "${label}" (index: ${optionIndex})`);
          }

          pending.answers[question.question] = currentLabels;
          pending.answerIndices[question.question] = currentIndices;

          // 選択状態を表示（メッセージ更新）
          const selected = currentLabels.length > 0 ? currentLabels.join(', ') : '(未選択)';
          await say({
            text: `${question.header || '質問'}: ${selected}\n「選択完了」を押して確定してください。`,
            thread_ts: threadTs,
          });
        } else {
          // 単一選択: 従来通り
          pending.answers[question.question] = [label];
          pending.answerIndices[question.question] = [optionIndex];
          console.log(`[ACTION] ${threadTs} - Answer recorded: "${question.question}" = "${label}" (index: ${optionIndex})`);

          // すべての質問に回答済みか確認（multiSelect以外）
          const allAnswered = pending.questions.every(q => {
            const answers = pending.answers[q.question];
            if (q.multiSelect) {
              // multiSelectは「選択完了」ボタンで確定
              return answers && answers.length > 0 && pending.confirmed[q.question];
            }
            return answers && answers.length > 0;
          });

          if (allAnswered) {
            await this.submitAnswers(pending, say, threadTs);
          } else {
            const remaining = pending.questions.filter(q => {
              const answers = pending.answers[q.question];
              return !answers || answers.length === 0;
            }).length;
            await say({
              text: `回答を受け付けました。残り${remaining}件の質問に回答してください。`,
              thread_ts: threadTs,
            });
          }
        }
      } catch (error) {
        console.error('[ACTION ERROR]', error);
      }
    });

    // multiSelectの「選択完了」ボタンハンドラ
    this.app.action<BlockAction<ButtonAction>>(/^ask_confirm_/, async ({ action, body, ack, say }) => {
      await ack();

      try {
        if (!action.value) {
          console.error('[CONFIRM] No value in action');
          return;
        }
        const value = JSON.parse(action.value);
        const { threadTs, questionIndex } = value;

        const pending = this.pendingQuestions.get(threadTs);
        if (!pending) {
          console.error(`[CONFIRM] No pending question for thread: ${threadTs}`);
          return;
        }

        const question = pending.questions[questionIndex];
        if (!question) {
          console.error(`[CONFIRM] Question not found at index: ${questionIndex}`);
          return;
        }

        // 選択が空の場合はエラー
        const selected = pending.answers[question.question] || [];
        if (selected.length === 0) {
          await say({
            text: `${question.header || '質問'}: 少なくとも1つ選択してください。`,
            thread_ts: threadTs,
          });
          return;
        }

        // この質問を確定済みとしてマーク
        pending.confirmed[question.question] = true;

        console.log(`[CONFIRM] ${threadTs} - Confirmed: "${question.question}" = [${selected.join(', ')}]`);

        // すべての質問に回答済みか確認
        const allAnswered = pending.questions.every(q => {
          const answers = pending.answers[q.question];
          if (!answers || answers.length === 0) return false;
          if (q.multiSelect) {
            return pending.confirmed[q.question] === true;
          }
          return true;
        });

        if (allAnswered) {
          await this.submitAnswers(pending, say, threadTs);
        } else {
          const remaining = pending.questions.filter(q => {
            const answers = pending.answers[q.question];
            if (!answers || answers.length === 0) return true;
            if (q.multiSelect) {
              return !pending.confirmed[q.question];
            }
            return false;
          }).length;
          await say({
            text: `選択を確定しました。残り${remaining}件の質問に回答してください。`,
            thread_ts: threadTs,
          });
        }
      } catch (error) {
        console.error('[CONFIRM ERROR]', error);
      }
    });
  }

  private async submitAnswers(pending: PendingQuestion, say: SayFn, threadTs: string): Promise<void> {
    // Slackに確認メッセージ
    const answerSummary = pending.questions
      .map(q => {
        const answers = pending.answers[q.question] || [];
        return `• ${q.header || '回答'}: ${answers.join(', ')}`;
      })
      .join('\n');

    await say({
      text: `回答を送信しています...\n${answerSummary}`,
      thread_ts: threadTs,
    });

    // 各質問の選択情報を構築
    const selections: import('./types').AnswerSelection[] = pending.questions.map((q, qIndex) => ({
      questionIndex: qIndex,
      selectedIndices: pending.answerIndices[q.question] || [],
      isMultiSelect: q.multiSelect === true,
      optionCount: q.options?.length || 0,
    }));

    // pendingQuestionsから削除
    this.pendingQuestions.delete(threadTs);

    // Claude Codeに回答を送信して応答を待機（キーストローク方式）
    const result = await this.claudeExecutor.sendUserAnswer(threadTs, selections);
    await this.handleWaitResult(result, say, threadTs);
  }

  private startCleanupTimer(): void {
    // 5分ごとにタイムアウトした質問をクリーンアップ
    setInterval(() => {
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5分

      for (const [threadTs, pending] of this.pendingQuestions.entries()) {
        if (now - pending.createdAt > timeout) {
          console.log(`[CLEANUP] Removing timed out question for thread: ${threadTs}`);
          this.pendingQuestions.delete(threadTs);
        }
      }
    }, 60 * 1000); // 1分ごとにチェック
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log('Bridge started');
  }

  async stop(): Promise<void> {
    await this.claudeExecutor.cleanup();
    await this.app.stop();
  }
}
