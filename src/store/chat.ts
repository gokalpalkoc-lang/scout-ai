import { create } from 'zustand';

import * as messagesDb from '../lib/db/messages';
import { AgentResult, runTurn } from '../lib/ai';
import { ChatMessage, ToolTrailEntry } from '../lib/types';
import { errorMessage, uid } from '../lib/util';
import { useApp } from './app';
import { readSettings } from './settings';

/**
 * Assistant conversation state.
 *
 * The streaming reply lives in `draft` rather than in `messages`, so the list
 * below it stays stable while text arrives — no re-keying, no scroll jumps. It
 * is committed to SQLite once the turn finishes.
 */

export interface ChatState {
  messages: ChatMessage[];
  /** Text streamed so far for the in-flight reply. */
  draft: string;
  /** Tool calls made during the in-flight reply. */
  activeTools: ToolTrailEntry[];
  /** Name of the tool running right now, for the status line. */
  runningTool: string | null;
  sending: boolean;
  loaded: boolean;
  error: string | null;

  load: () => Promise<void>;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  retryLast: () => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

let abortController: AbortController | null = null;

export const useChat = create<ChatState>((set, get) => ({
  messages: [],
  draft: '',
  activeTools: [],
  runningTool: null,
  sending: false,
  loaded: false,
  error: null,

  async load() {
    if (get().loaded) return;
    try {
      set({ messages: await messagesDb.listMessages(), loaded: true });
    } catch (e) {
      set({ error: errorMessage(e), loaded: true });
    }
  },

  async send(text) {
    const prompt = text.trim();
    if (!prompt || get().sending) return;

    const settings = await readSettings();

    const userMessage = await messagesDb.appendMessage({
      role: 'user',
      text: prompt,
      toolTrail: null,
      grounding: null,
      error: false,
    });

    // History for the model must exclude the message being answered.
    const history = get().messages;
    set({
      messages: [...history, userMessage],
      draft: '',
      activeTools: [],
      runningTool: null,
      error: null,
      sending: true,
    });

    abortController = new AbortController();
    const app = useApp.getState();

    let result: AgentResult;
    try {
      result = await runTurn({
        settings,
        history,
        userMessage: prompt,
        siteCount: app.sources.length,
        signal: abortController.signal,
        onDataChanged: () => {
          void useApp.getState().refreshAll();
        },
        callbacks: {
          onText: (delta) => set({ draft: get().draft + delta }),
          onToolStart: (name) => set({ runningTool: name }),
          onToolEnd: (entry) =>
            set({ activeTools: [...get().activeTools, entry], runningTool: null }),
        },
      });
    } catch (e) {
      result = {
        text: '',
        toolTrail: get().activeTools,
        grounding: [],
        error: errorMessage(e),
        rounds: 0,
      };
    }

    const trail = result.toolTrail.length ? result.toolTrail : get().activeTools;
    const body =
      result.text.trim() ||
      result.error ||
      'The model returned an empty response. Try rephrasing, or pick a different model in Settings.';

    const reply = await messagesDb.appendMessage({
      role: 'model',
      text: body,
      toolTrail: trail.length ? trail : null,
      grounding: result.grounding.length ? result.grounding : null,
      error: !result.text.trim() && !!result.error,
    });

    abortController = null;
    set({
      messages: [...get().messages, reply],
      draft: '',
      activeTools: [],
      runningTool: null,
      sending: false,
      error: result.error && result.text.trim() ? result.error : null,
    });
  },

  cancel() {
    abortController?.abort();
    abortController = null;
    const partial = get().draft.trim();
    set({ sending: false, runningTool: null });

    if (partial) {
      // Keep what already arrived rather than discarding the user's tokens.
      void messagesDb
        .appendMessage({
          role: 'model',
          text: `${partial}\n\n_(stopped)_`,
          toolTrail: get().activeTools.length ? get().activeTools : null,
          grounding: null,
          error: false,
        })
        .then((msg) => set({ messages: [...get().messages, msg], draft: '', activeTools: [] }));
    } else {
      set({ draft: '', activeTools: [] });
    }
  },

  async retryLast() {
    const messages = get().messages;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;

    // Drop the failed reply so the retry does not stack up.
    const last = messages[messages.length - 1];
    if (last && last.role === 'model') {
      await messagesDb.deleteMessage(last.id);
      set({ messages: messages.filter((m) => m.id !== last.id) });
    }
    // And the user turn, since `send` re-appends it.
    await messagesDb.deleteMessage(lastUser.id);
    set({ messages: get().messages.filter((m) => m.id !== lastUser.id) });

    await get().send(lastUser.text);
  },

  async removeMessage(id) {
    await messagesDb.deleteMessage(id);
    set({ messages: get().messages.filter((m) => m.id !== id) });
  },

  async clear() {
    abortController?.abort();
    abortController = null;
    await messagesDb.clearMessages();
    set({ messages: [], draft: '', activeTools: [], runningTool: null, sending: false, error: null });
  },
}));

/** Placeholder bubble used while the first tokens are still in flight. */
export function pendingMessage(draft: string): ChatMessage {
  return {
    id: uid('pending_'),
    role: 'model',
    text: draft,
    toolTrail: null,
    grounding: null,
    createdAt: Date.now(),
    error: false,
  };
}
