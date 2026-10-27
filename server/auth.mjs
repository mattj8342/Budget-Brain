import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createAuth({ issuer, resource, allowedSubjects, keySet }) {
  const issuerUrl = new URL(issuer);
  const resourceUrl = new URL(resource);
  if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || issuerUrl.pathname !== '/') throw new Error('AUTH0_ISSUER must be an HTTPS issuer root ending in /');
  if (issuer !== issuerUrl.href) throw new Error('AUTH0_ISSUER must include its trailing /');
  if (resourceUrl.protocol !== 'https:' || resourceUrl.username || resourceUrl.password || resourceUrl.search || resourceUrl.hash || resourceUrl.pathname !== '/mcp') throw new Error('MCP_RESOURCE_URL must be an HTTPS /mcp URL');
  const members = new Set((allowedSubjects ?? '').split(',').map(s => s.trim()).filter(Boolean));
  if (!members.size) throw new Error('ALLOWED_SUBJECTS requires at least one household member');
  const keys = keySet ?? createRemoteJWKSet(new URL('.well-known/jwks.json', issuer), { timeoutDuration: 5000 });
  const metadata = { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], resource_name: 'Budget Brain' };
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', resource).href;
  return {
    metadata,
    async authorize(req, res) {
      const header = req.headers.authorization ?? '';
      const match = /^Bearer ([^\s]+)$/i.exec(header);
      let payload;
      if (match) {
        try {
          ({ payload } = await jwtVerify(match[1], keys, {
            issuer, audience: resource, algorithms: ['RS256'],
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'], clockTolerance: 5,
          }));
        } catch { /* Do not log tokens or detailed verification errors. */ }
      }
      if (!payload) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"${match ? ', error="invalid_token"' : ''}` });
        res.end(JSON.stringify({ error: 'unauthorized' })); return false;
      }
      if (!members.has(payload.sub)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'household_access_denied' })); return false;
      }
      req.householdSubject = payload.sub; // Only derived from a verified token, never tool input.
      return true;
    },
  };
}

