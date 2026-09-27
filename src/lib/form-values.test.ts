import { describe, it, expect } from 'vitest';
import { submittedValues } from './form-values';
import { formKey } from '@/components/form-key';

describe('submittedValues — what a refusal hands back (W11)', () => {
  it('returns every text field as typed, Arabic and empty strings included', () => {
    const data = new FormData();
    data.set('titleAr', 'جداول تسليح');
    data.set('subtitleAr', '');
    data.set('amount', '35.255');
    expect(submittedValues(data)).toEqual({ titleAr: 'جداول تسليح', subtitleAr: '', amount: '35.255' });
  });

  it("leaves out Next's own $ACTION fields — they are not the user's", () => {
    const data = new FormData();
    data.set('$ACTION_ID_0123', '');
    data.set('$ACTION_REF_1', '');
    data.set('note', 'x');
    expect(submittedValues(data)).toEqual({ note: 'x' });
  });

  it('leaves out files — a file cannot be put back into an input', () => {
    const data = new FormData();
    data.set('file', new Blob(['%PDF']), 'a.pdf');
    data.set('productId', 'p');
    expect(submittedValues(data)).toEqual({ productId: 'p' });
  });

  it('a repeated name keeps its first value', () => {
    const data = new FormData();
    data.append('contributorId', 'a');
    data.append('contributorId', 'b');
    expect(submittedValues(data)).toEqual({ contributorId: 'a' });
  });

  it('an unchecked checkbox is absent, so the form can tell it from a checked one', () => {
    const data = new FormData();
    data.set('code', 'bank');
    expect('requiresProof' in submittedValues(data)).toBe(false);
  });
});

describe('formKey — a new key for every answer (W11)', () => {
  it('the same answer object keeps its key across renders', () => {
    const state = { error: 'x' };
    expect(formKey(state)).toBe(formKey(state));
  });

  it('two identical refusals are two answers, so the form remounts twice', () => {
    const first = { error: 'x', values: { a: '1' } };
    const second = { error: 'x', values: { a: '1' } };
    expect(formKey(first)).not.toBe(formKey(second));
  });
});
