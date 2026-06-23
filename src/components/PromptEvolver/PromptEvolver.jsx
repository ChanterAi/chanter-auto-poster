import { useMemo, useState } from 'react';
import { generatePromptVariants } from './promptGenerator';
import {
  ASPECT_RATIOS,
  CONTENT_TYPES,
  DEFAULT_PROMPT_EVOLVER_FORM,
  PLATFORMS,
  STYLE_PRESETS
} from './promptPresets';
import './PromptEvolver.css';

function formatForClipboard(variant) {
  if (!variant) return '';
  return [
    'MAIN PROMPT',
    variant.mainPrompt,
    '',
    'NEGATIVE PROMPT',
    variant.negativePrompt,
    '',
    'SUGGESTED CAPTION',
    variant.suggestedCaption,
    '',
    'SUGGESTED HASHTAGS',
    variant.suggestedHashtags,
    '',
    `SCORE: ${variant.score}/100`
  ].join('\n');
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function scoreTone(score) {
  if (score >= 88) return 'elite';
  if (score >= 78) return 'strong';
  return 'solid';
}

function FieldSelect({ id, label, value, options, onChange }) {
  return (
    <label className="prompt-evolver-field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function PromptBlock({ label, value }) {
  if (!value) return null;
  return (
    <div className="prompt-evolver-block">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  );
}

function WinnerPanel({ winner, onCopy, onEvolveAgain, copied }) {
  return (
    <section className="prompt-evolver-panel prompt-evolver-winner" aria-label="Winner output">
      <div className="prompt-evolver-panel-head">
        <div>
          <span className="prompt-evolver-kicker">Winner</span>
          <h3>{winner ? winner.title : 'No prompt generated'}</h3>
        </div>
        {winner ? (
          <div className={`prompt-evolver-score ${scoreTone(winner.score)}`}>
            <strong>{winner.score}</strong>
            <span>/100</span>
          </div>
        ) : null}
      </div>

      {winner ? (
        <>
          <PromptBlock label="Main prompt" value={winner.mainPrompt} />
          <PromptBlock label="Negative prompt" value={winner.negativePrompt} />
          <PromptBlock label="Caption" value={winner.suggestedCaption} />
          <PromptBlock label="Hashtags" value={winner.suggestedHashtags} />
          <div className="prompt-evolver-actions">
            <button className="prompt-evolver-button primary" type="button" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy winner'}
            </button>
            <button className="prompt-evolver-button secondary" type="button" onClick={onEvolveAgain}>
              Evolve again
            </button>
          </div>
        </>
      ) : (
        <div className="prompt-evolver-empty">
          <strong>Ready for a source idea.</strong>
          <span>The strongest scored variant will appear here.</span>
        </div>
      )}
    </section>
  );
}

function VariantCard({ variant, active, onSelect }) {
  return (
    <article className={`prompt-evolver-variant${active ? ' active' : ''}`}>
      <div className="prompt-evolver-variant-head">
        <div>
          <span>Variant</span>
          <h4>{variant.title}</h4>
        </div>
        <strong>{variant.score}</strong>
      </div>
      <p>{variant.mainPrompt}</p>
      <button type="button" onClick={() => onSelect(variant)}>
        {active ? 'Selected winner' : 'Use as winner'}
      </button>
    </article>
  );
}

export default function PromptEvolver() {
  const [form, setForm] = useState(DEFAULT_PROMPT_EVOLVER_FORM);
  const [generation, setGeneration] = useState(0);
  const [variants, setVariants] = useState([]);
  const [winner, setWinner] = useState(null);
  const [copied, setCopied] = useState(false);

  const canGenerate = form.idea.trim().length > 0;
  const selectedLabels = useMemo(() => {
    const contentType = CONTENT_TYPES.find((item) => item.id === form.contentType);
    const preset = STYLE_PRESETS.find((item) => item.id === form.stylePreset);
    const platform = PLATFORMS.find((item) => item.id === form.platform);
    return [contentType?.label, preset?.label, platform?.label].filter(Boolean).join(' / ');
  }, [form.contentType, form.platform, form.stylePreset]);

  const updateForm = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setCopied(false);
  };

  const runGeneration = (nextIdea = form.idea, nextGeneration = generation) => {
    const result = generatePromptVariants({
      ...form,
      idea: nextIdea,
      generation: nextGeneration
    });
    setVariants(result.variants);
    setWinner(result.winner);
    setCopied(false);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!canGenerate) return;
    setGeneration(0);
    runGeneration(form.idea, 0);
  };

  const handleCopy = async () => {
    if (!winner) return;
    await copyText(formatForClipboard(winner));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleEvolveAgain = () => {
    if (!winner) return;
    const nextGeneration = generation + 1;
    const evolvedIdea = winner.mainPrompt;
    setGeneration(nextGeneration);
    setForm((current) => ({ ...current, idea: evolvedIdea }));
    runGeneration(evolvedIdea, nextGeneration);
  };

  const selectWinner = (variant) => {
    setWinner(variant);
    setCopied(false);
  };

  return (
    <div className="prompt-evolver">
      <div className="prompt-evolver-head">
        <div>
          <span className="prompt-evolver-kicker">Prompt Evolver</span>
          <h2>Creative Engine</h2>
        </div>
        <span className="prompt-evolver-meta">{selectedLabels || 'Local rule engine'}</span>
      </div>

      <div className="prompt-evolver-grid">
        <form className="prompt-evolver-panel prompt-evolver-input" onSubmit={handleSubmit}>
          <div className="prompt-evolver-panel-head">
            <div>
              <span className="prompt-evolver-kicker">Input</span>
              <h3>Source idea</h3>
            </div>
            <span className="prompt-evolver-step">01</span>
          </div>

          <label className="prompt-evolver-field wide" htmlFor="prompt-evolver-idea">
            <span>Quote / idea</span>
            <textarea
              id="prompt-evolver-idea"
              value={form.idea}
              placeholder="Example: Discipline is choosing the future over the mood."
              onChange={(event) => updateForm('idea', event.target.value)}
            />
          </label>

          <div className="prompt-evolver-controls">
            <FieldSelect
              id="prompt-evolver-content-type"
              label="Content type"
              value={form.contentType}
              options={CONTENT_TYPES}
              onChange={(value) => updateForm('contentType', value)}
            />
            <FieldSelect
              id="prompt-evolver-style"
              label="Style preset"
              value={form.stylePreset}
              options={STYLE_PRESETS}
              onChange={(value) => updateForm('stylePreset', value)}
            />
            <FieldSelect
              id="prompt-evolver-platform"
              label="Platform"
              value={form.platform}
              options={PLATFORMS}
              onChange={(value) => updateForm('platform', value)}
            />
            <FieldSelect
              id="prompt-evolver-ratio"
              label="Aspect ratio"
              value={form.aspectRatio}
              options={ASPECT_RATIOS}
              onChange={(value) => updateForm('aspectRatio', value)}
            />
          </div>

          <button className="prompt-evolver-button primary wide-button" type="submit" disabled={!canGenerate}>
            Generate 8 variants
          </button>
        </form>

        <WinnerPanel
          winner={winner}
          copied={copied}
          onCopy={handleCopy}
          onEvolveAgain={handleEvolveAgain}
        />
      </div>

      {variants.length > 0 ? (
        <section className="prompt-evolver-variants" aria-label="Prompt variants">
          <div className="prompt-evolver-variants-head">
            <span>{variants.length} variants scored</span>
            <strong>Highest score wins by default</strong>
          </div>
          <div className="prompt-evolver-variant-grid">
            {variants.map((variant) => (
              <VariantCard
                key={variant.id}
                variant={variant}
                active={winner && winner.id === variant.id}
                onSelect={selectWinner}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
