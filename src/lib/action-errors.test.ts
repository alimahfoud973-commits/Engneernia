import { describe, expect, it, vi, afterEach } from 'vitest';
import { toUserMessage } from './action-errors';
import { logger } from './logger';
import {
  ConflictError, MoneyInvariantError, NotFoundError, RuleViolationError, ValidationError,
} from './errors';

afterEach(() => vi.restoreAllMocks());

describe('toUserMessage', () => {
  it('shows a validation message, and does not log it as a fault', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    expect(toUserMessage(new ValidationError('كلمة المرور قصيرة'), 'ctx')).toBe('كلمة المرور قصيرة');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['a broken rule', new RuleViolationError('الحصص يجب أن تساوي 100%')],
    ['a conflict', new ConflictError('الطلب عولج بالفعل')],
    ['a missing resource', new NotFoundError('الملف غير متاح')],
  ])('shows %s as written', (_label, error) => {
    expect(toUserMessage(error, 'ctx')).toBe(error.message);
  });

  it('never shows a money invariant, and always logs it', () => {
    /**
     * The defect this exists for. MoneyInvariantError is an AppError, so
     * `instanceof AppError` matched it, returned its message to the browser,
     * and never reached the logger — on the adjustment and settlement screens,
     * which are exactly where it would fire.
     */
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const error = new MoneyInvariantError('Split does not re-sum to the net price');

    const shown = toUserMessage(error, 'adjustment preview failed');

    expect(shown).not.toContain('invariant');
    expect(shown).not.toContain('re-sum');
    expect(shown).toBe('تعذّر إتمام العملية. حاول مرة أخرى.');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[1]).toBe('adjustment preview failed');
  });

  it('logs an unrecognised error and says nothing about it', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const shown = toUserMessage(new Error('ECONNREFUSED 10.0.0.5:5432'), 'ctx');

    expect(shown).not.toContain('10.0.0.5');
    expect(spy).toHaveBeenCalledOnce();
  });
});
