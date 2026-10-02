import { networkInterfaces, hostname } from 'node:os';
import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = new URL('../.certs/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
try { await access(new URL('ca-key.pem', directory)); throw new Error('Certificates already exist; refusing to replace the trusted CA.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const addresses = [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal).map(address => address.address)])];
const names = [...new Set(['localhost', hostname(), `${hostname().replace(/\.local$/, '')}.local`])];
const san = [...names.map((name, index) => `DNS.${index + 1} = ${name}`), ...addresses.map((address, index) => `IP.${index + 1} = ${address}`)].join('\n');
await writeFile(new URL('server.cnf', directory), `[req]\nprompt = no\ndistinguished_name = subject\nreq_extensions = extensions\n[subject]\nCN = Media Streamer local server\n[extensions]\nsubjectAltName = @names\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\n[names]\n${san}\n`);
await writeFile(new URL('ca.cnf', directory), '[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = extensions\n[subject]\nCN = Media Streamer local development CA\n[extensions]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n');
function openssl(args) {
  const result = spawnSync('openssl', args, { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('OpenSSL certificate generation failed');
}
openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca-cert.pem', '-days', '365', '-config', 'ca.cnf']);
await chmod(new URL('ca-key.pem', directory), 0o600);
openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server-key.pem', '-out', 'server.csr', '-config', 'server.cnf']);
await chmod(new URL('server-key.pem', directory), 0o600);
openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial', '-out', 'server-cert.pem', '-days', '90', '-extfile', 'server.cnf', '-extensions', 'extensions']);
openssl(['verify', '-CAfile', 'ca-cert.pem', 'server-cert.pem']);
console.log(`\nGenerated local HTTPS certificates in .certs. Addresses: ${addresses.join(', ')}.\nOnly ca-cert.pem is intended for import on test devices. Keep both private keys on this Mac. No trust settings were changed.`);
