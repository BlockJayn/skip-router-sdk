import {
  encodeSecp256k1Pubkey,
  makeSignDoc as makeSignDocAmino,
  OfflineAminoSigner,
} from "@cosmjs/amino";
import { createWasmAminoConverters } from "@cosmjs/cosmwasm-stargate";
import { fromBase64 } from "@cosmjs/encoding";
import { Int53 } from "@cosmjs/math";
import {
  Coin,
  encodePubkey,
  isOfflineDirectSigner,
  makeAuthInfoBytes,
  makeSignDoc,
  OfflineDirectSigner,
  OfflineSigner,
  Registry,
  TxBodyEncodeObject,
} from "@cosmjs/proto-signing";
import {
  AminoTypes,
  createDefaultAminoConverters,
  defaultRegistryTypes,
  SignerData,
  SigningStargateClient,
  StdFee,
} from "@cosmjs/stargate";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";

import { RequestClient } from "./request-client";
import {
  getAccountNumberAndSequence,
  getEncodeObjectFromMultiChainMessage,
  getGasAmountForMessage,
} from "./transactions";
import {
  Asset,
  assetFromJSON,
  AssetJSON,
  assetRecommendationFromJSON,
  AssetRecommendationJSON,
  AssetsFromSourceRequest,
  AssetsFromSourceRequestJSON,
  assetsFromSourceRequestToJSON,
  AssetsRequest,
  AssetsRequestJSON,
  assetsRequestToJSON,
  Chain,
  chainFromJSON,
  ChainJSON,
  MsgsRequest,
  MsgsRequestJSON,
  msgsRequestToJSON,
  MsgsResponseJSON,
  MultiChainMsg,
  multiChainMsgFromJSON,
  RecommendAssetsRequest,
  recommendAssetsRequestToJSON,
  RouteRequest,
  RouteRequestJSON,
  routeRequestToJSON,
  RouteResponse,
  routeResponseFromJSON,
  RouteResponseJSON,
  SubmitTxRequestJSON,
  SubmitTxResponse,
  submitTxResponseFromJSON,
  SubmitTxResponseJSON,
  SwapVenue,
  swapVenueFromJSON,
  SwapVenueJSON,
  TrackTxRequestJSON,
  TrackTxResponse,
  trackTxResponseFromJSON,
  TrackTxResponseJSON,
  TxStatusRequestJSON,
  TxStatusResponse,
  txStatusResponseFromJSON,
  TxStatusResponseJSON,
} from "./types";

export const SKIP_API_URL = "https://api.skip.money/v1";

export class SkipAPIClient {
  private requestClient: RequestClient;

  private aminoTypes: AminoTypes;
  private registry: Registry;

  constructor(apiURL: string) {
    this.requestClient = new RequestClient(apiURL);

    this.aminoTypes = new AminoTypes({
      ...createDefaultAminoConverters(),
      ...createWasmAminoConverters(),
    });

    this.registry = new Registry(defaultRegistryTypes);
    this.registry.register(
      "/cosmwasm.wasm.v1.MsgExecuteContract",
      MsgExecuteContract,
    );
  }

  async assets(options: AssetsRequest = {}): Promise<Record<string, Asset[]>> {
    const response = await this.requestClient.get<
      {
        chain_to_assets_map: Record<string, { assets: AssetJSON[] }>;
      },
      AssetsRequestJSON
    >("/fungible/assets", assetsRequestToJSON(options));

    return Object.entries(response.chain_to_assets_map).reduce(
      (acc, [chainID, { assets }]) => {
        acc[chainID] = assets.map((asset) => assetFromJSON(asset));
        return acc;
      },
      {} as Record<string, Asset[]>,
    );
  }

  async assetsFromSource(
    options: AssetsFromSourceRequest,
  ): Promise<Record<string, Asset[]>> {
    const response = await this.requestClient.post<
      {
        dest_assets: Record<string, { assets: AssetJSON[] }>;
      },
      AssetsFromSourceRequestJSON
    >("/fungible/assets_from_source", assetsFromSourceRequestToJSON(options));

    return Object.entries(response.dest_assets).reduce(
      (acc, [chainID, { assets }]) => {
        acc[chainID] = assets.map((asset) => assetFromJSON(asset));
        return acc;
      },
      {} as Record<string, Asset[]>,
    );
  }

  async chains(): Promise<Chain[]> {
    const response = await this.requestClient.get<{ chains: ChainJSON[] }>(
      "/info/chains",
    );

    return response.chains.map((chain) => chainFromJSON(chain));
  }

  async executeMultiChainMessage(
    signerAddress: string,
    signer: OfflineSigner,
    message: MultiChainMsg,
    feeAmount: Coin,
    options: {
      rpcEndpoint: string;
    },
  ) {
    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error("Failed to retrieve account from signer");
    }

    const { accountNumber, sequence } = await getAccountNumberAndSequence(
      signerAddress,
      options.rpcEndpoint,
    );

    const gas = getGasAmountForMessage(message);

    let rawTx: TxRaw;
    if (isOfflineDirectSigner(signer)) {
      rawTx = await this.signMultiChainMessageDirect(
        signerAddress,
        signer,
        message,
        {
          amount: [feeAmount],
          gas,
        },
        { accountNumber, sequence, chainId: message.chainID },
      );
    } else {
      rawTx = await this.signMultiChainMessageAmino(
        signerAddress,
        signer,
        message,
        {
          amount: [feeAmount],
          gas,
        },
        { accountNumber, sequence, chainId: message.chainID },
      );
    }

    const txBytes = TxRaw.encode(rawTx).finish();

    const stargateClient = await SigningStargateClient.connectWithSigner(
      options.rpcEndpoint,
      signer,
    );

    const tx = await stargateClient.broadcastTx(txBytes);

    return tx;
  }

  async signMultiChainMessageDirect(
    signerAddress: string,
    signer: OfflineDirectSigner,
    multiChainMessage: MultiChainMsg,
    fee: StdFee,
    { accountNumber, sequence, chainId }: SignerData,
  ): Promise<TxRaw> {
    // TODO: Uncomment when EVMOS and Injective are supported
    // if (multiChainMessage.chain_id.includes("evmos")) {
    //   return this.signMultiChainMessageDirectEvmos(
    //     signerAddress,
    //     signer,
    //     multiChainMessage,
    //     fee,
    //     { accountNumber, sequence, chainId }
    //   );
    // }

    // if (multiChainMessage.chain_id.includes("injective")) {
    //   return this.signMultiChainMessageDirectInjective(
    //     signerAddress,
    //     signer,
    //     multiChainMessage,
    //     fee,
    //     { accountNumber, sequence, chainId }
    //   );
    // }

    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error("Failed to retrieve account from signer");
    }

    const message = getEncodeObjectFromMultiChainMessage(multiChainMessage);

    const pubkey = encodePubkey(
      encodeSecp256k1Pubkey(accountFromSigner.pubkey),
    );

    const txBodyEncodeObject: TxBodyEncodeObject = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: {
        messages: [message],
      },
    };

    const txBodyBytes = this.registry.encode(txBodyEncodeObject);

    const gasLimit = Int53.fromString(fee.gas).toNumber();

    const authInfoBytes = makeAuthInfoBytes(
      [{ pubkey, sequence }],
      fee.amount,
      gasLimit,
      fee.granter,
      fee.payer,
    );

    const signDoc = makeSignDoc(
      txBodyBytes,
      authInfoBytes,
      chainId,
      accountNumber,
    );

    const { signature, signed } = await signer.signDirect(
      signerAddress,
      signDoc,
    );

    return TxRaw.fromPartial({
      bodyBytes: signed.bodyBytes,
      authInfoBytes: signed.authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    });
  }

  async signMultiChainMessageAmino(
    signerAddress: string,
    signer: OfflineAminoSigner,
    multiChainMessage: MultiChainMsg,
    fee: StdFee,
    { accountNumber, sequence, chainId }: SignerData,
  ): Promise<TxRaw> {
    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error("Failed to retrieve account from signer");
    }

    const message = getEncodeObjectFromMultiChainMessage(multiChainMessage);

    const pubkey = encodePubkey(
      encodeSecp256k1Pubkey(accountFromSigner.pubkey),
    );

    const signMode = SignMode.SIGN_MODE_LEGACY_AMINO_JSON;

    const msgs = [this.aminoTypes.toAmino(message)];

    msgs[0].value.memo = message.value.memo;

    const signDoc = makeSignDocAmino(
      msgs,
      fee,
      chainId,
      "",
      accountNumber,
      sequence,
    );

    const { signature, signed } = await signer.signAmino(
      signerAddress,
      signDoc,
    );

    const signedTxBody = {
      messages: signed.msgs.map((msg) => this.aminoTypes.fromAmino(msg)),
      memo: signed.memo,
    };

    signedTxBody.messages[0].value.memo = message.value.memo;

    const signedTxBodyEncodeObject: TxBodyEncodeObject = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: signedTxBody,
    };

    const signedTxBodyBytes = this.registry.encode(signedTxBodyEncodeObject);

    const signedGasLimit = Int53.fromString(signed.fee.gas).toNumber();
    const signedSequence = Int53.fromString(signed.sequence).toNumber();

    const signedAuthInfoBytes = makeAuthInfoBytes(
      [{ pubkey, sequence: signedSequence }],
      signed.fee.amount,
      signedGasLimit,
      signed.fee.granter,
      signed.fee.payer,
      signMode,
    );

    return TxRaw.fromPartial({
      bodyBytes: signedTxBodyBytes,
      authInfoBytes: signedAuthInfoBytes,
      signatures: [fromBase64(signature.signature)],
    });
  }

  async messages(options: MsgsRequest): Promise<MultiChainMsg[]> {
    const response = await this.requestClient.post<
      MsgsResponseJSON,
      MsgsRequestJSON
    >("/fungible/msgs", {
      ...msgsRequestToJSON(options),
      slippage_tolerance_percent: options.slippageTolerancePercent ?? "0",
    });

    return response.msgs.map((msg) => multiChainMsgFromJSON(msg));
  }

  async route(options: RouteRequest): Promise<RouteResponse> {
    const response = await this.requestClient.post<
      RouteResponseJSON,
      RouteRequestJSON
    >("/fungible/route", {
      ...routeRequestToJSON(options),
      cumulative_affiliate_fee_bps: options.cumulativeAffiliateFeeBPS ?? "0",
    });

    return routeResponseFromJSON(response);
  }

  async recommendAssets(options: RecommendAssetsRequest) {
    const response = await this.requestClient.post<{
      recommendations: AssetRecommendationJSON[];
    }>("/fungible/recommend_assets", recommendAssetsRequestToJSON(options));

    return response.recommendations.map((recommendation) =>
      assetRecommendationFromJSON(recommendation),
    );
  }

  async submitTransaction(
    chainID: string,
    tx: string,
  ): Promise<SubmitTxResponse> {
    const response = await this.requestClient.post<
      SubmitTxResponseJSON,
      SubmitTxRequestJSON
    >("/tx/submit", {
      chain_id: chainID,
      tx: tx,
    });

    return submitTxResponseFromJSON(response);
  }

  async trackTransaction(
    chainID: string,
    txHash: string,
  ): Promise<TrackTxResponse> {
    const response = await this.requestClient.post<
      TrackTxResponseJSON,
      TrackTxRequestJSON
    >("/tx/track", {
      chain_id: chainID,
      tx_hash: txHash,
    });

    return trackTxResponseFromJSON(response);
  }

  async transactionStatus(
    chainID: string,
    txHash: string,
  ): Promise<TxStatusResponse> {
    const response = await this.requestClient.get<
      TxStatusResponseJSON,
      TxStatusRequestJSON
    >("/tx/status", {
      chain_id: chainID,
      tx_hash: txHash,
    });

    return txStatusResponseFromJSON(response);
  }

  async venues(): Promise<SwapVenue[]> {
    const response = await this.requestClient.get<{ venues: SwapVenueJSON[] }>(
      "/fungible/venues",
    );

    return response.venues.map((venue) => swapVenueFromJSON(venue));
  }
}
