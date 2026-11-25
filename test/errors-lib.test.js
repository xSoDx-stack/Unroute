import assert from 'node:assert/strict';
import { clarify, formatErrorMessage, getErrorCode } from '../src/common/core/errors-lib.js';

describe('Error chain formatting', () => {
  it('formats a standard wrapped error and preserves its nested code', () => {
    const error = clarify(Object.assign(new Error('Read failed'), { code: 'READ_FAILED' }), 'Retry');
    assert.equal(formatErrorMessage(error), 'Retry > Read failed');
    assert.equal(getErrorCode(error), 'READ_FAILED');
  });

  it('handles an unserializable diagnostic and stops at a repeated cause', () => {
    const root = { diagnosticId: 1n };
    const error = clarify(root, 'Retry');
    root.wrapped = error;
    assert.equal(formatErrorMessage(error), 'Retry > [Unserializable error]');
    assert.equal(getErrorCode(error), '');
  });
});
