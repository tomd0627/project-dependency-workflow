import { jest } from '@jest/globals';
import { waitForApproval } from '../src/gate.js';

const BASE = {
  owner: 'org',
  repo: 'repo',
  issueNumber: 1,
  _pollIntervalMs: 10
};

const EXPIRED = Date.now() - 1000;
const FUTURE = Date.now() + 5000;

function makeComment(body) {
  return {
    body,
    user: { login: 'approver' },
    created_at: new Date().toISOString()
  };
}

function makeOctokit(firstComments, secondComments = null) {
  const listComments = jest.fn();
  
  if (secondComments === null) {
    // Single call case
    listComments.mockResolvedValue({ data: firstComments });
  } else {
    // Multiple call case
    listComments
      .mockResolvedValueOnce({ data: firstComments })
      .mockResolvedValue({ data: secondComments });
  }
  
  return {
    rest: {
      issues: {
        listComments
      }
    }
  };
}

describe('waitForApproval', () => {
  describe('timeout', () => {
    it('returns "timeout" when deadline is already past', async () => {
      const octokit = makeOctokit([]);
      const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: EXPIRED });
      expect(result).toBe('timeout');
      expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('returns "approved" after finding the keyword on the second poll', async () => {
      const octokit = makeOctokit([], [makeComment('APPROVE')]);
      const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
      expect(result).toBe('approved');
      expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
    });
  });
});
