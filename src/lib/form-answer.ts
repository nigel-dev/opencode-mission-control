import type { FormField, FormInfo, FormOption, FormValue } from '@opencode/client';

// Dependency-free helpers for answering session forms. Shared by the server
// part and the TUI part, so this module must only have type-only imports.

function getFormToolId(form: FormInfo): string | undefined {
  const tool = form.metadata?.tool;
  if (tool && typeof tool === 'object' && 'id' in tool) {
    const id = (tool as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function getFormKind(form: FormInfo): string | undefined {
  const kind = form.metadata?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * Locate the form backing a question tool call. V2 renders the `question` tool
 * as a session form, so the tool call id is stored in form metadata.
 */
export function findQuestionForm(forms: readonly FormInfo[], partId: string): FormInfo | undefined {
  const exact = forms.find((form) => getFormToolId(form) === partId);
  if (exact) return exact;

  const questions = forms.filter((form) => getFormKind(form) === 'question');
  return questions.length === 1 ? questions[0] : undefined;
}

function matchOptionValue(options: readonly FormOption[] | undefined, raw: string): string {
  const text = raw.trim();
  if (!options) return text;
  const match = options.find(
    (option) =>
      option.value.toLowerCase() === text.toLowerCase() ||
      option.label.toLowerCase() === text.toLowerCase(),
  );
  return match ? match.value : text;
}

function coerceFormField(field: FormField, raw: string): FormValue {
  switch (field.type) {
    case 'multiselect': {
      const parts = raw
        .split(/[,\n;]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      return parts.map((part) => matchOptionValue(field.options, part));
    }
    case 'boolean':
      return /^(true|yes|y|1|on)$/i.test(raw.trim());
    case 'number':
    case 'integer': {
      const value = Number(raw.trim());
      return Number.isFinite(value) ? value : raw.trim();
    }
    case 'string':
      return field.options && field.options.length > 0
        ? matchOptionValue(field.options, raw)
        : raw;
    default:
      return raw;
  }
}

export function buildFormAnswer(
  fields: readonly FormField[],
  response: string,
): Record<string, FormValue> {
  const answer: Record<string, FormValue> = {};
  const lines = response.split(/\r?\n/).map((line) => line.trim());
  const linePerField = fields.length > 1 && lines.length >= fields.length;

  fields.forEach((field, index) => {
    const raw = fields.length === 1
      ? response
      : linePerField
        ? lines[index]
        : index === 0
          ? response
          : '';
    answer[field.key] = coerceFormField(field, raw);
  });

  return answer;
}
