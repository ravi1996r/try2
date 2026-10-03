import { useState } from 'react';
import { ADAPTERS, type ProviderAdapter } from '../lib/providerAdapters';

export interface SwitcherHandle {
  adapter: ProviderAdapter;
  apiKey: string;
  model: string;
}

/**
 * Model switcher: the BYOK panel.
 *
 * THE ONE INVARIANT: the key typed here never leaves the browser except to the provider the visitor
 * chose. It is handed to the parent through an imperative handle rather than React state, so it is
 * never rendered, never serialised into a devtools snapshot or an error boundary dump, and never
 * written to storage. There is deliberately NO "remember my key" checkbox: persisting a credential in
 * localStorage is a downgrade, and offering it would be the easy path this project exists to avoid.
 *
 * WHY an imperative handle rather than a context or lifted state: the chat panel needs the key at
 * send time only. Routing it through state would put it in every render of every component in the
 * tree for no benefit.
 *
 * WHY the cost label is rendered verbatim from the adapter: AGENTS.md forbids cost claims that are not
 * sourced, and a hand-written "free" next to a paid provider is exactly the kind of claim that rots.
 */
export function ModelSwitcher({ handle }: { handle?: React.MutableRefObject<SwitcherHandle | null> }) {
  const [adapter, setAdapter] = useState<ProviderAdapter>(ADAPTERS[0]);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(ADAPTERS[0].defaultModel);

  const needsKey = adapter.id !== 'ollama';

  // WHY publish on every render rather than in an effect: the effect would run after the chat panel's
  // first render, and a user who typed a key and sent immediately could still have sent with the
  // previous value. Publishing during render keeps the handle current for the next click.
  if (handle) handle.current = { adapter, apiKey, model };

  return (
    <section className="switcher" aria-labelledby="switcher-heading">
      <h2 id="switcher-heading">Model settings</h2>
      <p className="switcher-note">
        Using your own key sends your question straight from this browser to the provider you choose.
        The key is never sent to this site&rsquo;s server, and it is not saved when you close the tab.
      </p>

      <div className="switcher-field">
        <label htmlFor="provider-select">Provider</label>
        <select
          id="provider-select"
          value={adapter.id}
          onChange={(e) => {
            const next = ADAPTERS.find((a) => a.id === e.target.value);
            if (!next) return;
            setAdapter(next);
            // WHY reset the model with the provider: a model id from one provider is meaningless to
            // another, and leaving it would produce a confusing 404-shaped error from the provider.
            setModel(next.defaultModel);
          }}
        >
          {ADAPTERS.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
        {/* WHY role="status": this label changes with the provider and it is a cost statement the
            visitor must actually see before sending anything. */}
        <p className="switcher-cost" role="status" data-remote={adapter.isRemote}>
          {adapter.costLabel}
          {adapter.isRemote
            ? ' Your question and key go to this provider, not to this site.'
            : ' Nothing leaves your machine.'}
        </p>
      </div>

      {needsKey && (
        <div className="switcher-field">
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-describedby="api-key-help"
          />
          <p id="api-key-help" className="switcher-help">
            Held in this tab only. It is sent to {adapter.label} with your question and is never sent
            to this site&rsquo;s server.
          </p>
        </div>
      )}

      <div className="switcher-field">
        <label htmlFor="model-input">Model</label>
        <input
          id="model-input"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
    </section>
  );
}