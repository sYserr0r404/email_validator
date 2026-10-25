import dns from 'dns/promises';

/**
 * Perform DNS checks for email domain
 * Returns { mx, a, aaaa, spf, dmarc, error }
 */
export async function checkDNS(domain) {
  const result = {
    mx: [],
    a: null,
    aaaa: null,
    spf: null,
    dmarc: null,
    error: null
  };

  try {
    // Check MX records
    try {
      const mxRecords = await dns.resolveMx(domain);
      result.mx = mxRecords
        .sort((a, b) => a.priority - b.priority)
        .map(r => ({ exchange: r.exchange, priority: r.priority }));
      
      // Check for null MX (RFC 7505)
      if (mxRecords.length === 1 && mxRecords[0].exchange === '.') {
        result.error = 'null-mx';
        return result;
      }
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
        // No MX, try A/AAAA
        result.mx = [];
      } else {
        throw err;
      }
    }

    // If no MX, check A/AAAA (domain itself can receive mail)
    if (result.mx.length === 0) {
      try {
        const aRecords = await dns.resolve4(domain);
        if (aRecords.length > 0) {
          result.a = aRecords[0];
          result.mx = [{ exchange: domain, priority: 0 }];
        }
      } catch (err) {
        // Ignore, try AAAA
      }

      if (!result.a) {
        try {
          const aaaaRecords = await dns.resolve6(domain);
          if (aaaaRecords.length > 0) {
            result.aaaa = aaaaRecords[0];
            result.mx = [{ exchange: domain, priority: 0 }];
          }
        } catch (err) {
          // Ignore
        }
      }
    }

    // Check SPF
    try {
      const txtRecords = await dns.resolveTxt(domain);
      for (const record of txtRecords) {
        const txt = record.join('');
        if (txt.startsWith('v=spf1')) {
          result.spf = txt;
          break;
        }
      }
    } catch (err) {
      // Ignore
    }

    // Check DMARC
    try {
      const dmarcDomain = `_dmarc.${domain}`;
      const txtRecords = await dns.resolveTxt(dmarcDomain);
      for (const record of txtRecords) {
        const txt = record.join('');
        if (txt.startsWith('v=DMARC1')) {
          result.dmarc = txt;
          break;
        }
      }
    } catch (err) {
      // Ignore
    }

  } catch (err) {
    if (err.code === 'ENOTFOUND') {
      result.error = 'domain-not-found';
    } else if (err.code === 'ENODATA') {
      result.error = 'no-records';
    } else {
      result.error = err.message;
    }
  }

  return result;
}
