/**
 * Check for common typos in email domains
 * Based on deep-email-validator logic
 */

const commonDomains = {
  'gmail.com': ['gmial.com', 'gmai.com', 'gmil.com', 'gmal.com', 'gamil.com'],
  'yahoo.com': ['yaho.com', 'yahooo.com', 'yhaoo.com', 'yahoo.co'],
  'outlook.com': ['outlok.com', 'outloo.com', 'putlook.com'],
  'hotmail.com': ['hotmial.com', 'hotmai.com', 'hotmal.com', 'hotmil.com'],
  'live.com': ['livecom', 'liv.com'],
  'icloud.com': ['icloudcom', 'icoud.com', 'iclod.com'],
  'protonmail.com': ['protonmailcom', 'protommail.com']
};

/**
 * Check for typos and suggest corrections
 * Returns { suggestion: string | null }
 */
export async function checkTypo(email) {
  const domain = email.split('@')[1];
  if (!domain) return { suggestion: null };

  const lowerDomain = domain.toLowerCase();

  // Check if domain is a known typo
  for (const [correct, typos] of Object.entries(commonDomains)) {
    if (typos.includes(lowerDomain)) {
      const local = email.split('@')[0];
      return { suggestion: `${local}@${correct}` };
    }
  }

  // Check for simple edit distance (1-2 chars different)
  for (const correct of Object.keys(commonDomains)) {
    if (levenshteinDistance(lowerDomain, correct) <= 2 && lowerDomain !== correct) {
      const local = email.split('@')[0];
      return { suggestion: `${local}@${correct}` };
    }
  }

  return { suggestion: null };
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
