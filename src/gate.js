export async function waitForApproval({
  owner,
  repo,
  issueNumber,
  octokit,
  _deadlineMs = Date.now() + 30 * 60 * 1000, // 30 minutes default
  _pollIntervalMs = 5000 // 5 seconds default
}) {
  // Check if deadline has already passed before starting
  if (Date.now() >= _deadlineMs) {
    return 'timeout';
  }

  while (Date.now() < _deadlineMs) {
    try {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber
      });

      // Look for approval keyword in comments
      const hasApproval = comments.some(comment => 
        comment.body && comment.body.includes('APPROVE')
      );

      if (hasApproval) {
        return 'approved';
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, _pollIntervalMs));
    } catch (error) {
      // On API errors, continue polling until timeout
      await new Promise(resolve => setTimeout(resolve, _pollIntervalMs));
    }
  }

  return 'timeout';
}
