// Liveness for Kubernetes: the Node server answers. No dependencies on purpose.
export function GET(): Response {
  return Response.json({ status: 'alive' });
}
