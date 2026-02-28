import { agentConfig } from '../agent.config';

export async function ghostfolioGet<T>({
  path,
  jwt
}: {
  path: string;
  jwt: string;
}): Promise<T> {
  const baseUrl = agentConfig.ghostfolioApiUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ghostfolio API ${response.status}: ${body}`);
  }

  return (await response.json()) as T;
}

export async function ghostfolioPost<T>({
  path,
  jwt,
  body
}: {
  path: string;
  jwt: string;
  body: unknown;
}): Promise<T> {
  const baseUrl = agentConfig.ghostfolioApiUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ghostfolio API POST ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}
