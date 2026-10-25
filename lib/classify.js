/**
 * Classify email verification result into status: VALID, INVALID, RISKY, or UNKNOWN
 * Based on all collected information
 */

const BIG_PROVIDERS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'protonmail.com'
];

export function classify(checkResult) {
  const {
    syntax,
    disposable,
    typoSuggestion,
    dns,
    smtp,
    smtpMode,
    domain
  } = checkResult;

  // INVALID cases
  if (!syntax.valid) {
    return { status: 'INVALID', reason: syntax.reason };
  }

  if (disposable) {
    return { status: 'INVALID', reason: 'Disposable email domain' };
  }

  if (dns.error === 'domain-not-found') {
    return { status: 'INVALID', reason: 'Domain does not exist' };
  }

  if (dns.error === 'null-mx') {
    return { status: 'INVALID', reason: 'Null MX record (RFC 7505)' };
  }

  if (dns.mx.length === 0 && !dns.a && !dns.aaaa) {
    return { status: 'INVALID', reason: 'No mail servers found' };
  }

  // SMTP rejection codes with plain language
  if (smtp && smtp.code && !smtp.error) {
    // Check 5.7.x policy blocks first (before generic 5xx)
    if (smtp.enhancedCode && smtp.enhancedCode.startsWith('5.7')) {
      return {
        status: 'UNKNOWN',
        reason: 'Server blocked the check. Retry later.'
      };
    }
    
    // Then check rejection codes
    if (smtp.code === 550 || smtp.code === 551 || smtp.code === 553) {
      return { status: 'INVALID', reason: 'Mailbox does not exist' };
    }
    
    if (smtp.enhancedCode) {
      if (['5.1.1', '5.1.2', '5.1.3'].includes(smtp.enhancedCode)) {
        return { status: 'INVALID', reason: 'Mailbox does not exist' };
      }
    }
  }

  // RISKY cases
  if (typoSuggestion) {
    return { 
      status: 'RISKY', 
      reason: `Possible typo. Did you mean ${typoSuggestion}?` 
    };
  }

  if (smtp && smtp.catchAll) {
    return { 
      status: 'RISKY', 
      reason: 'Catch-all domain (accepts any address)' 
    };
  }

  if (domain && BIG_PROVIDERS.includes(domain.toLowerCase())) {
    return { 
      status: 'RISKY', 
      reason: 'Provider does not confirm mailboxes' 
    };
  }

  // UNKNOWN cases
  if (smtpMode === 'dns-only') {
    return {
      status: 'UNKNOWN',
      reason: 'Outbound port 25 is blocked on this server, so the mailbox could not be verified.'
    };
  }

  if (smtp && smtp.error) {
    // Plain language for timeout
    if (smtp.error.includes('timeout') || smtp.error.includes('did not respond')) {
      return {
        status: 'UNKNOWN',
        reason: 'Server did not respond. You can retry.'
      };
    }
    
    // Plain language for connection refused
    if (smtp.error.includes('refused')) {
      return {
        status: 'UNKNOWN',
        reason: 'Server refused connection. You can retry.'
      };
    }

    return {
      status: 'UNKNOWN',
      reason: smtp.error
    };
  }

  if (smtp && smtp.code) {
    // 4xx temporary failures (greylisting)
    if (smtp.code >= 400 && smtp.code < 500) {
      return {
        status: 'UNKNOWN',
        reason: 'Server asked us to retry later.'
      };
    }

    // 421 service not available
    if (smtp.code === 421) {
      return {
        status: 'UNKNOWN',
        reason: 'Server asked us to retry later.'
      };
    }
  }

  // VALID: all checks passed
  if (smtp && smtp.accepted && !smtp.catchAll) {
    return {
      status: 'VALID',
      reason: 'Mailbox verified'
    };
  }

  // Fallback: if we have MX but couldn't verify
  if (dns.mx.length > 0) {
    return {
      status: 'UNKNOWN',
      reason: 'Domain valid, mailbox not verified'
    };
  }

  return {
    status: 'UNKNOWN',
    reason: 'Unable to determine status'
  };
}
