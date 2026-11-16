import { describe, it, expect } from 'bun:test';
import type { FormField, FormInfo } from '@opencode/client';
import { buildFormAnswer, findQuestionForm } from '../../src/lib/question-relay';

function makeForm(overrides: Partial<FormInfo> = {}): FormInfo {
  return {
    id: 'frm_1',
    sessionID: 'ses_1',
    title: 'Questions',
    metadata: {},
    fields: [],
    ...overrides,
  };
}

const stringField: FormField = {
  key: 'q0',
  title: 'Color',
  description: 'Which color?',
  type: 'string',
  options: [
    { value: 'red', label: 'Red' },
    { value: 'blue', label: 'Blue' },
  ],
  custom: true,
};

describe('findQuestionForm', () => {
  it('matches the form whose metadata tool id equals the question part id', () => {
    const matching = makeForm({ id: 'frm_match', metadata: { tool: { id: 'call-1' } } });
    const other = makeForm({ id: 'frm_other', metadata: { tool: { id: 'call-2' } } });

    expect(findQuestionForm([other, matching], 'call-1')?.id).toBe('frm_match');
  });

  it('falls back to the single form marked as a question', () => {
    const question = makeForm({ id: 'frm_question', metadata: { kind: 'question' } });

    expect(findQuestionForm([question], 'missing-call')?.id).toBe('frm_question');
  });

  it('returns undefined when no exact match and multiple question forms exist', () => {
    const first = makeForm({ id: 'frm_1', metadata: { kind: 'question' } });
    const second = makeForm({ id: 'frm_2', metadata: { kind: 'question' } });

    expect(findQuestionForm([first, second], 'missing-call')).toBeUndefined();
  });

  it('returns undefined when the only form is not a question', () => {
    const form = makeForm({ id: 'frm_1', metadata: { kind: 'other' } });

    expect(findQuestionForm([form], 'missing-call')).toBeUndefined();
  });
});

describe('buildFormAnswer', () => {
  it('uses the whole response for a single field', () => {
    expect(buildFormAnswer([stringField], 'blue')).toEqual({ q0: 'blue' });
  });

  it('matches an option by value or label case-insensitively', () => {
    expect(buildFormAnswer([stringField], 'BLUE')).toEqual({ q0: 'blue' });
    expect(buildFormAnswer([stringField], 'Red')).toEqual({ q0: 'red' });
  });

  it('keeps free text when no option matches', () => {
    expect(buildFormAnswer([stringField], 'green')).toEqual({ q0: 'green' });
  });

  it('coerces boolean fields', () => {
    const field: FormField = { key: 'ok', type: 'boolean' };

    expect(buildFormAnswer([field], 'yes')).toEqual({ ok: true });
    expect(buildFormAnswer([field], 'no')).toEqual({ ok: false });
  });

  it('coerces number and integer fields', () => {
    expect(buildFormAnswer([{ key: 'n', type: 'number' }], '3.5')).toEqual({ n: 3.5 });
    expect(buildFormAnswer([{ key: 'i', type: 'integer' }], '7')).toEqual({ i: 7 });
  });

  it('keeps the raw value when a numeric field is not finite', () => {
    expect(buildFormAnswer([{ key: 'n', type: 'number' }], 'many')).toEqual({ n: 'many' });
  });

  it('splits multiselect answers and maps them to option values', () => {
    const field: FormField = {
      key: 'colors',
      type: 'multiselect',
      options: [
        { value: 'r', label: 'Red' },
        { value: 'b', label: 'Blue' },
      ],
    };

    expect(buildFormAnswer([field], 'Red, blue')).toEqual({ colors: ['r', 'b'] });
  });

  it('maps one line per field when there are multiple fields', () => {
    const fields: FormField[] = [
      { key: 'first', type: 'string' },
      { key: 'second', type: 'string' },
    ];

    expect(buildFormAnswer(fields, 'hello\nworld')).toEqual({
      first: 'hello',
      second: 'world',
    });
  });

  it('uses the first line for the first field when there are fewer lines than fields', () => {
    const fields: FormField[] = [
      { key: 'first', type: 'string' },
      { key: 'second', type: 'string' },
    ];

    expect(buildFormAnswer(fields, 'only')).toEqual({ first: 'only', second: '' });
  });
});
