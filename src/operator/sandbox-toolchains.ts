export const M07_NODE_TOOLCHAIN = Object.freeze({
  profileId: "node22-sandbox-v1" as const,
  image: "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe" as const,
  imageId: "sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe" as const,
  nodeVersion: "22.23.2" as const,
  user: "node" as const,
  memory: "1536m" as const,
  cpus: "2" as const,
  pidsLimit: 256 as const,
  scratchBytes: 512 * 1024 * 1024,
});

export type M07ToolchainProfileId = typeof M07_NODE_TOOLCHAIN.profileId;
