/**
 * Chat panel: a site-path SSE client for bot1 / bot2 / bot3.
 *
 * WHY the panel posts to the SITE path and not to a provider: the site path uses the project's model
 * and the server's key, so nothing sensitive lives in the browser. The visitor-key path is a separate,
 * explicit opt-in (see ModelSwitcher).
 */
import { useCallback, useRef, useState } from 'react';
import type { StreamEvent } from '../lib/events';
import { openChatStream, ChatHttpError } from '../lib/chatClient';
import { runBrowserChat, ProviderError } from '../lib/browserChat';
import type { SwitcherHandle } from './ModelSwitcher';

const BOTS = [
  { id: 'bot1', label: 'About Ravi', hint: 'Resume-backed answers about experience, skills and projects.' },
  { id: 'bot2', label: 'My documents', hint: 'Answers only from documents you drop in. No upload UI in this build.' },
  { id: 'bot3', label: 'Research', hint: 'Web-search backed. Search is experimental in this build.' },
] as const;

type BotId = (typeof BOTS)[number]['id'];
/** Which model pays for the answer. Both paths assemble context from the same gateway endpoint. */
type ChatPath = 'site' | 'browser';

interface Turn {
  question: string;
  answer: string;
  sources: Array<{ id: string; title: string; locator?: string }>;
  error?: string;
  status: string;
}

export function ChatPanel({
  activeSection,
  byok,
  onToolCall,
}: {
  activeSection?: string;
  /** The switcher's live settings, read at send time so a typed key is never held in React state. */
  byok: React.MutableRefObject<SwitcherHandle | null>;
  /**
   * Applies one Master bot action. Optional so the panel still renders in tests and in the no-JS
   * fallback, where no bot is ever running.
   *
   * WHY the panel does not apply actions itself: the page must be able to refuse one. Passing the raw
   * action to a store that owns the safety rules keeps a single decision point, so the chat UI can
   * never become a second, weaker path to changing the visitor's screen.
   */
  onToolCall?: (action: unknown) => boolean;
}) {
  const [bot, setBot] = useState<BotId>('bot1');
  const [path, setPath] = useState<ChatPath>('site');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /** Mutation helper for the in-flight turn, which is always the last one. */
  const patchLast = useCallback((patch: (t: Turn) => Turn) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = patch(next[next.length - 1]);
      return next;
    });
  }, []);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setDraft('');
    setTurns((prev) => [...prev, {
      question: message, answer: '', sources: [], status: 'Sending\u2026',
    }]);

    try {
      if (path === 'browser') {
        const settings = byok.current;
        // WHY fail before sending rather than sending an empty key: a request with a blank credential
        // would reach the provider and come back as an opaque 401, which reads as "the site is broken".
        if (!settings) throw new ProviderError('this site', 0, 'Model settings are not ready yet.');
        if (settings.adapter.id !== 'ollama' && settings.apiKey.trim() === '') {
          throw new ProviderError(settings.adapter.label, 0,
            'Enter your API key in Model settings, or switch back to the site model.');
        }
        patchLast((t) => ({ ...t, status: 'Searching sources\u2026' }));
        await runBrowserChat(
          {
            adapter: settings.adapter,
            apiKey: settings.apiKey,
            model: settings.model,
            bot,
            message,
          },
          (text) => patchLast((t) => ({ ...t, answer: t.answer + text, status: 'Streaming\u2026' })),
          (sources) => patchLast((t) => ({ ...t, sources })),
          controller.signal,
        );
        patchLast((t) => ({ ...t, status: 'Done' }));
      } else {
        await openChatStream({ bot, message }, (event: StreamEvent) => {
          // WHY handled OUTSIDE patchLast: applying an action changes page state, not turn state, so
          // routing it through the turn reducer would make a tool_call look like it was part of the
          // answer and would rebuild the turn object for no reason.
          if (event.type === 'tool_call') {
            // WHY the refusal is reported: if the store rejects the action, the model may still narrate
            // "I've switched the theme". Saying so in the transcript is what stops the page from
            // claiming a change that never happened.
            const applied = onToolCall?.({ name: event.tool_call.name, args: event.tool_call.args })
              ?? false;
            if (!applied) {
              patchLast((turn) => ({
                ...turn,
                error: 'That change was not allowed by the site\u2019s safety rules.',
              }));
            }
            return;
          }
          patchLast((turn) => {
            if (event.type === 'token') return { ...turn, answer: turn.answer + event.token.text };
            if (event.type === 'source') {
              return {
                ...turn,
                sources: [...turn.sources, {
                  id: event.source.id, title: event.source.title, locator: event.source.locator,
                }],
              };
            }
            if (event.type === 'status') {
              return { ...turn, status: event.status.detail || event.status.state };
            }
            if (event.type === 'error') {
              // WHY only message_safe: the schema guarantees that field is display-safe, and it is the
              // only error field this browser may render.
              return { ...turn, error: event.error.message_safe };
            }
            if (event.type === 'done') return { ...turn, status: 'Done' };
            return turn;
          });
        }, controller.signal);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      patchLast((turn) => ({
        ...turn,
        // WHY every message here is pre-written: a fetch failure can embed the request URL, and for
        // the browser path that URL may be a provider endpoint. Nothing derived from the error object
        // reaches the visitor.
        error: err instanceof ChatHttpError || err instanceof ProviderError
          ? err.message
          : 'The connection failed before an answer arrived. The rest of the page still works.',
      }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [bot, busy, draft, path, patchLast]);

  return (
    <section className="chat" aria-labelledby="chat-heading" data-active-section={activeSection}>
      <h2 id="chat-heading">Ask about Ravi</h2>

      <div className="chat-bots" role="group" aria-label="Who answers">
        {/*
          WHY a radio group rather than two buttons: "who pays for this" is a single exclusive choice,
          and radios announce that to a screen reader. Two aria-pressed buttons would read as two
          independent toggles, which is a different (and wrong) mental model.
        */}
        <label className="chat-path">
          <input
            type="radio"
            name="chat-path"
            value="site"
            checked={path === 'site'}
            onChange={() => setPath('site')}
          />
          Site model
        </label>
        <label className="chat-path">
          <input
            type="radio"
            name="chat-path"
            value="browser"
            checked={path === 'browser'}
            onChange={() => setPath('browser')}
          />
          My own model
        </label>
      </div>
      <p className="chat-hint">
        {path === 'site'
          ? 'Answered by this site. No key needed.'
          : 'Answered by the provider you chose in Model settings, from your browser. Your key goes to that provider only.'}
      </p>

      <div className="chat-bots" role="group" aria-label="Choose an assistant">
        {BOTS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="chat-bot"
            aria-pressed={bot === b.id}
            title={b.hint}
            onClick={() => setBot(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <p className="chat-hint">{BOTS.find((b) => b.id === bot)?.hint}</p>

      {/*
        WHY role="log" + aria-live="polite": the transcript grows as tokens stream in. Without this a
        screen reader either interrupts on every token or says nothing. `polite` queues instead.
      */}
      <div className="chat-log" role="log" aria-live="polite" aria-relevant="additions text">
        {turns.length === 0 && (
          <p className="chat-empty">No questions yet. Try &ldquo;What has he built with Gen-AI?&rdquo;</p>
        )}
        {turns.map((t, i) => (
          <article key={i} className="chat-turn">
            <h3 className="chat-question">{t.question}</h3>
            {t.error
              ? <p className="chat-error" role="alert">{t.error}</p>
              : <p className="chat-answer">{t.answer || '\u2026'}</p>}
            {t.sources.length > 0 && (
              <details className="chat-sources">
                <summary>{t.sources.length} source(s)</summary>
                <ul>
                  {t.sources.map((s) => (
                    <li key={s.id}>{s.locator ? `${s.title} \u2014 ${s.locator}` : s.title}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="chat-status">{t.status}</p>
          </article>
        ))}
      </div>

      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="visually-hidden" htmlFor="chat-input">Your question</label>
        <input
          id="chat-input"
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about Ravi's experience"
          maxLength={8000}
          disabled={busy}
        />
        <button type="submit" className="chat-send" disabled={busy || draft.trim() === ''}>
          {busy ? 'Streaming\u2026' : 'Ask'}
        </button>
        {busy && (
          <button type="button" className="chat-cancel" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        )}
      </form>
    </section>
  );
}