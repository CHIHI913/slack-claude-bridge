// AskUserQuestion関連の型定義

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionToolUse {
  type: 'tool_use';
  name: 'AskUserQuestion';
  id: string;
  input: { questions: AskUserQuestionItem[] };
}

export type WaitResult =
  | { type: 'final'; text: string }
  | { type: 'ask_user_question'; toolUse: AskUserQuestionToolUse; sessionId: string; threadTs: string };

export interface PendingQuestion {
  threadTs: string;
  sessionId: string;
  toolUseId: string;
  questions: AskUserQuestionItem[];
  answers: Record<string, string[]>;  // multiSelect対応で配列に
  // 各質問の選択肢インデックス（0-based）、multiSelectの場合は複数
  answerIndices: Record<string, number[]>;
  // multiSelectの質問が確定済みかどうか
  confirmed: Record<string, boolean>;
  createdAt: number;
}

export interface AnswerSelection {
  questionIndex: number;
  selectedIndices: number[];
  isMultiSelect: boolean;
  optionCount: number;  // Submit位置計算用
}
