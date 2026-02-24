import { agentConfig } from '../agent.config';

export async function ghostfolioGet<T>({
  path,
  jwt
}: {
  path: string;
  jwt: string;
}): Promise<T> {
  const response = await fetch(`${agentConfig.ghostfolioApiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${jwt}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ghostfolio API ${response.status}: ${body}`);
  }

  return (await response.json()) as T;
}
