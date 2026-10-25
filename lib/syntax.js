import { domainToASCII } from 'url';

/**
 * Validate email syntax according to RFC 5321/5322
 * Returns { valid: boolean, local?: string, domain?: string, reason?: string }
 */
export function validateSyntax(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, reason: 'Empty or invalid input' };
  }

  const trimmed = email.trim();
  
  // Total length limit (RFC 5321: 64 local + @ + 255 domain = 320, but RFC 5322 says 254)
  if (trimmed.length > 254) {
    return { valid: false, reason: 'Email too long (max 254 chars)' };
  }

  // Must have exactly one @
  const atIndex = trimmed.indexOf('@');
  const lastAtIndex = trimmed.lastIndexOf('@');
  
  if (atIndex === -1 || atIndex !== lastAtIndex) {
    return { valid: false, reason: 'Must have exactly one @ sign' };
  }

  const local = trimmed.substring(0, atIndex);
  const domain = trimmed.substring(atIndex + 1);

  // Local part validation
  if (!local || local.length === 0) {
    return { valid: false, reason: 'Missing local part' };
  }
  
  if (local.length > 64) {
    return { valid: false, reason: 'Local part too long (max 64 chars)' };
  }

  // Basic local part regex (simplified, covers most real cases)
  if (!/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) {
    return { valid: false, reason: 'Invalid characters in local part' };
  }

  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { valid: false, reason: 'Invalid dot placement in local part' };
  }

  // Domain validation
  if (!domain || domain.length === 0) {
    return { valid: false, reason: 'Missing domain' };
  }

  if (domain.length > 255) {
    return { valid: false, reason: 'Domain too long (max 255 chars)' };
  }

  // Domain must contain at least one dot
  if (!domain.includes('.')) {
    return { valid: false, reason: 'Domain must contain a dot' };
  }

  // Convert IDN to ASCII (punycode)
  let normalizedDomain;
  try {
    normalizedDomain = domainToASCII(domain);
    if (!normalizedDomain) {
      return { valid: false, reason: 'Invalid domain encoding' };
    }
  } catch (error) {
    return { valid: false, reason: 'Invalid domain encoding' };
  }

  // Basic domain regex
  if (!/^[a-z0-9.-]+$/.test(normalizedDomain.toLowerCase())) {
    return { valid: false, reason: 'Invalid characters in domain' };
  }

  // Check for invalid patterns
  if (normalizedDomain.startsWith('.') || normalizedDomain.endsWith('.') || 
      normalizedDomain.startsWith('-') || normalizedDomain.endsWith('-') ||
      normalizedDomain.includes('..')) {
    return { valid: false, reason: 'Invalid domain format' };
  }

  // TLD must be at least 2 chars
  const parts = normalizedDomain.split('.');
  const tld = parts[parts.length - 1];
  if (tld.length < 2) {
    return { valid: false, reason: 'Invalid TLD' };
  }

  return { 
    valid: true, 
    local, 
    domain: normalizedDomain.toLowerCase() 
  };
}

/**
 * Check if the local part is a role account
 */
export function isRoleAccount(local) {
  const roleAccounts = [
    'admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster',
    'info', 'support', 'help', 'sales', 'contact', 'noreply', 'no-reply'
  ];
  return roleAccounts.includes(local.toLowerCase());
}
