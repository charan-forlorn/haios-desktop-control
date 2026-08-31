export const M07_NODE_TOOLCHAIN = Object.freeze({
  profileId: "node22-sandbox-v1" as const,
  image: "haios-operator-sandbox-node@sha256:c0a0293478bb7eff92a33281597ad374cf0c1f71793f489ce8b49f6349b82b2e" as const,
  imageId: "sha256:c0a0293478bb7eff92a33281597ad374cf0c1f71793f489ce8b49f6349b82b2e" as const,
  nodeVersion: "22.23.2" as const,
  user: "node" as const,
  memory: "1536m" as const,
  cpus: "2" as const,
  pidsLimit: 256 as const,
  scratchBytes: 512 * 1024 * 1024,
});

export type M07ToolchainProfileId = typeof M07_NODE_TOOLCHAIN.profileId;
