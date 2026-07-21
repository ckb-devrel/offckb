// network
export enum Network {
  devnet = 'devnet',
  testnet = 'testnet',
  mainnet = 'mainnet',
}

export interface NetworkOption {
  network: Network;
}

export type H256 = string;

export type HexString = string;
export type HexNumber = string;

export type UdtKind = 'sudt' | 'xudt';
