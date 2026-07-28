// force-dynamic: render on every request so we actually call the REST service each load,
// instead of Next pre-rendering this page once at build time.
export const dynamic = 'force-dynamic';

async function getMessage() {
  try {
    // REST_HELLO_URL is injected by the sandbox CLI (generateFeatureEnv): a local
    // sibling in this feature → http://rest-hello:3000, otherwise the k8s
    // port-forward → http://k8s-forwards:9052. Falls back to cluster DNS when
    // deployed straight into k8s (no sandbox .env). This fetch runs on the SERVER.
    const restUrl = process.env.REST_HELLO_URL || 'http://rest-hello';
    const res = await fetch(restUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`REST returned ${res.status}`);
    const data = await res.json();
    return data.message; // the string from the REST service
  } catch (err) {
    return `could not reach rest-hello: ${err.message}`;
  }
}

export default async function Home() {
  const message = await getMessage();
  return (
    <main style={{ padding: '2rem' }}>
      <h1>Hello from Next.js 👋</h1>
      <p>Message from the REST service: <strong>{message}</strong></p>
      <p>Running on OrbStack Kubernetes.</p>
    </main>
  );
}
