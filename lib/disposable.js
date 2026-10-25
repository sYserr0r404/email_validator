// Common disposable email domains
const disposableDomains = [
  '10minutemail.com', '20minutemail.com', '33mail.com', 'anonbox.net',
  'anonymbox.com', 'binkmail.com', 'burnermail.io', 'crazymailing.com',
  'deadaddress.com', 'disposeamail.com', 'disposable.com', 'dispostable.com',
  'emailondeck.com', 'fakeinbox.com', 'fakemailgenerator.com', 'getairmail.com',
  'getnada.com', 'guerrillamail.com', 'guerrillamailblock.com', 'harakirimail.com',
  'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailinator2.com',
  'mailnesia.com', 'mailnull.com', 'mailsac.com', 'mailtothis.com',
  'mintemail.com', 'mytemp.email', 'mytrashmail.com', 'nada.email',
  'sharklasers.com', 'spambox.us', 'spamgourmet.com', 'temp-mail.org',
  'tempail.com', 'tempemail.net', 'tempm.com', 'tempmail.it',
  'tempmailo.com', 'tempsky.com', 'throwaway.email', 'trashmail.com',
  'trash-mail.com', 'wegwerfmail.de', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'zippymail.info'
];

const disposableSet = new Set(disposableDomains);

/**
 * Check if domain is a disposable email provider
 */
export function isDisposable(domain) {
  return disposableSet.has(domain.toLowerCase());
}
