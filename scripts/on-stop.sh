#!/bin/zsh
# Claude Code Stop hook用スクリプト
# 応答完了時に呼び出され、完了マーカーを作成する

# 現在処理中のthread_tsを読み取り（すでに.は-に置換済み）
THREAD_TS=$(cat /tmp/claude_current_thread 2>/dev/null)

if [ -n "$THREAD_TS" ]; then
    # 完了マーカー作成
    touch "/tmp/claude_done_${THREAD_TS}"

    # デバッグログ
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stop hook triggered for thread: ${THREAD_TS}" >> /tmp/claude_stop_hook.log
fi
