import { makeSignDoc as makeSignDocAmino } from "@cosmjs/amino";
import {
  createWasmAminoConverters,
  SigningCosmWasmClient,
} from "@cosmjs/cosmwasm-stargate";
import { fromBase64 } from "@cosmjs/encoding";
import { Int53 } from "@cosmjs/math";
import { Decimal } from "@cosmjs/math";
import { makePubkeyAnyFromAccount } from "./proto-signing/pubkey";
import {
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
  calculateFee,
  createDefaultAminoConverters,
  defaultRegistryTypes,
  GasPrice,
  SignerData,
  StargateClient,
  StdFee,
} from "@cosmjs/stargate";
import {
  ChainRestAuthApi,
  ChainRestTendermintApi,
} from "@injectivelabs/sdk-ts/dist/cjs/client/chain/rest";
import {
  BigNumberInBase,
  DEFAULT_BLOCK_TIMEOUT_HEIGHT,
} from "@injectivelabs/utils";
import axios from "axios";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import Long from "long";
import { accountParser } from "./parser";
import { maxUint256, publicActions, WalletClient } from "viem";

import chains from "./chains";
import {
  circleAminoConverters,
  circleProtoRegistry,
} from "./codegen/circle/client";
import { erc20ABI } from "./constants/abis";
import { DEFAULT_GAS_DENOM_OVERRIDES } from "./constants/constants";
import { createTransaction } from "./injective";
import { RequestClient } from "./request-client";
import {
  DEFAULT_GAS_MULTIPLIER,
  getEncodeObjectFromMultiChainMessage,
  getEncodeObjectFromMultiChainMessageInjective,
  getGasAmountForMessage,
} from "./transactions";
import * as types from "./types";
import * as clientTypes from "./client-types";

export const SKIP_API_URL = "https://api.skip.money";

export class SkipRouter {
  private requestClient: RequestClient;

  private aminoTypes: AminoTypes;
  private registry: Registry;

  private clientID: string;

  private endpointOptions: {
    endpoints?: Record<string, clientTypes.EndpointOptions>;
    getRpcEndpointForChain?: (chainID: string) => Promise<string>;
    getRestEndpointForChain?: (chainID: string) => Promise<string>;
  };

  private getCosmosSigner?: (chainID: string) => Promise<OfflineSigner>;
  private getEVMSigner?: (chainID: string) => Promise<WalletClient>;

  constructor(options: clientTypes.SkipRouterOptions = {}) {
    this.clientID = options.clientID || "skip-router-js";
    this.requestClient = new RequestClient(options.apiURL || SKIP_API_URL);

    this.aminoTypes = new AminoTypes({
      ...createDefaultAminoConverters(),
      ...createWasmAminoConverters(),
      ...circleAminoConverters,
      ...(options.aminoTypes ?? {}),
    });

    this.registry = new Registry([
      ...defaultRegistryTypes,
      ["/cosmwasm.wasm.v1.MsgExecuteContract", MsgExecuteContract],
      ...circleProtoRegistry,
      ...(options.registryTypes ?? []),
    ]);

    this.endpointOptions = options.endpointOptions ?? {};
    this.getCosmosSigner = options.getCosmosSigner;
    this.getEVMSigner = options.getEVMSigner;
  }

  async assets(
    options: types.AssetsRequest = {},
  ): Promise<Record<string, types.Asset[]>> {
    const response = await this.requestClient.get<
      {
        chain_to_assets_map: Record<string, { assets: types.AssetJSON[] }>;
      },
      types.AssetsRequestJSON
    >(
      "/v1/fungible/assets",
      types.assetsRequestToJSON({
        ...options,
        clientID: this.clientID,
      }),
    );

    return Object.entries(response.chain_to_assets_map).reduce(
      (acc, [chainID, { assets }]) => {
        acc[chainID] = assets.map((asset) => types.assetFromJSON(asset));
        return acc;
      },
      {} as Record<string, types.Asset[]>,
    );
  }

  async assetsFromSource(
    options: types.AssetsFromSourceRequest,
  ): Promise<Record<string, types.Asset[]>> {
    const response = await this.requestClient.post<
      {
        dest_assets: Record<string, { assets: types.AssetJSON[] }>;
      },
      types.AssetsFromSourceRequestJSON
    >(
      "/v1/fungible/assets_from_source",
      types.assetsFromSourceRequestToJSON({
        ...options,
        clientID: this.clientID,
      }),
    );

    return Object.entries(response.dest_assets).reduce(
      (acc, [chainID, { assets }]) => {
        acc[chainID] = assets.map((asset) => types.assetFromJSON(asset));
        return acc;
      },
      {} as Record<string, types.Asset[]>,
    );
  }

  async assetsBetweenChains(
    options: types.AssetsBetweenChainsRequest,
  ): Promise<types.AssetBetweenChains[]> {
    const response =
      await this.requestClient.post<types.AssetsBetweenChainsResponseJSON>(
        "/v2/fungible/assets_between_chains",
        types.assetsBetweenChainsRequestToJSON(options),
      );

    return types.assetsBetweenChainsResponseFromJSON(response)
      .assetsBetweenChains;
  }

  async bridges(): Promise<types.Bridge[]> {
    const response = await this.requestClient.get<types.BridgesResponseJSON>(
      "/v2/info/bridges",
      {
        client_id: this.clientID,
      },
    );

    return types.bridgesResponseFromJSON(response).bridges;
  }

  async chains(
    {
      includeEVM,
    }: {
      includeEVM?: boolean;
    } = { includeEVM: false },
  ): Promise<types.Chain[]> {
    const response = await this.requestClient.get<{
      chains: types.ChainJSON[];
    }>("/v1/info/chains", {
      include_evm: includeEVM,
      client_id: this.clientID,
    });

    return response.chains.map((chain) => types.chainFromJSON(chain));
  }

  async executeRoute(options: clientTypes.ExecuteRouteOptions) {
    const {
      route,
      userAddresses,
      validateGasBalance,
      getGasPrice,
      gasAmountMultiplier = DEFAULT_GAS_MULTIPLIER,
    } = options;

    const getOfflineSigner = this.getCosmosSigner || options.getCosmosSigner;
    if (!getOfflineSigner) {
      throw new Error(
        "executeRoute error: 'getCosmosSigner' is not provided or configured in skip router",
      );
    }

    const addressList = route.chainIDs.map((chainID) => {
      return (
        userAddresses[chainID] ||
        raise(`executeRoute error: invalid address for chain '${chainID}'`)
      );
    });

    const messages = await this.messages({
      sourceAssetDenom: route.sourceAssetDenom,
      sourceAssetChainID: route.sourceAssetChainID,
      destAssetDenom: route.destAssetDenom,
      destAssetChainID: route.destAssetChainID,
      amountIn: route.amountIn,
      amountOut: route.estimatedAmountOut || "0",
      addressList: addressList,
      operations: route.operations,
      slippageTolerancePercent: options.slippageTolerancePercent || "1",
    });

    if (validateGasBalance) {
      // check balances on chains where a tx is initiated
      await this.validateGasBalances(
        messages,
        userAddresses,
        getOfflineSigner,
        getGasPrice,
        gasAmountMultiplier,
      );
    }

    // execute txs
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;

      if ("multiChainMsg" in message) {
        const { multiChainMsg } = message;

        const signer = await getOfflineSigner(multiChainMsg.chainID);

        const gasPriceResolver = getGasPrice || this.getRecommendedGasPrice;

        const gasPrice =
          (await gasPriceResolver(multiChainMsg.chainID)) ||
          raise(
            `executeRoute error: unable to get gas prices for chain '${multiChainMsg.chainID}'`,
          );

        const endpoint = await this.getRpcEndpointForChain(
          multiChainMsg.chainID,
        );

        const client = await SigningCosmWasmClient.connectWithSigner(
          endpoint,
          signer,
          {
            aminoTypes: this.aminoTypes,
            registry: this.registry,
          },
        );

        const currentUserAddress = userAddresses[multiChainMsg.chainID];
        if (!currentUserAddress) {
          throw new Error(
            `executeRoute error: invalid address for chain '${multiChainMsg.chainID}'`,
          );
        }

        const estimatedGas = await getGasAmountForMessage(
          client,
          currentUserAddress,
          multiChainMsg,
          gasAmountMultiplier,
        );

        const fee = calculateFee(Math.ceil(parseFloat(estimatedGas)), gasPrice);

        if (!fee) {
          throw new Error(
            `executeRoute error: unable to get fee for message #${i}`,
          );
        }

        const tx = await this.executeMultiChainMessage({
          signerAddress: currentUserAddress,
          signer,
          message: multiChainMsg,
          fee,
        });

        if (options.onTransactionBroadcast) {
          await options.onTransactionBroadcast({
            chainID: multiChainMsg.chainID,
            txHash: tx.transactionHash,
          });
        }

        const txStatusResponse = await this.waitForTransaction({
          chainID: multiChainMsg.chainID,
          txHash: tx.transactionHash,
          onTransactionTracked: options.onTransactionTracked,
        });

        if (options.onTransactionCompleted) {
          await options.onTransactionCompleted(
            multiChainMsg.chainID,
            tx.transactionHash,
            txStatusResponse,
          );
        }
      }

      if ("evmTx" in message) {
        const { evmTx } = message;

        const getEVMSigner = options.getEVMSigner || this.getEVMSigner;
        if (!getEVMSigner) {
          throw new Error(
            "executeRoute error: 'getEVMSigner' is not provided or configured in skip router",
          );
        }

        const evmSigner = await getEVMSigner(evmTx.chainID);

        const txReceipt = await this.executeEVMTransaction({
          message: evmTx,
          signer: evmSigner,
        });

        if (options.onTransactionBroadcast) {
          await options.onTransactionBroadcast({
            chainID: evmTx.chainID,
            txHash: txReceipt.transactionHash,
          });
        }

        const txStatusResponse = await this.waitForTransaction({
          chainID: evmTx.chainID,
          txHash: txReceipt.transactionHash,
          onTransactionTracked: options.onTransactionTracked,
        });

        if (options.onTransactionCompleted) {
          await options.onTransactionCompleted(
            evmTx.chainID,
            txReceipt.transactionHash,
            txStatusResponse,
          );
        }
      }
    }
  }

  async executeMultiChainMessage(
    options: clientTypes.ExecuteMultiChainMessageOptions,
  ) {
    const { signerAddress, signer, message, fee } = options;

    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error(
        "executeMultiChainMessage error: failed to retrieve account from signer",
      );
    }

    const endpoint = await this.getRpcEndpointForChain(message.chainID);

    const stargateClient = await SigningCosmWasmClient.connectWithSigner(
      endpoint,
      signer,
      {
        aminoTypes: this.aminoTypes,
        registry: this.registry,
      },
    );
    const { accountNumber, sequence } = await this.getAccountNumberAndSequence(
      signerAddress,
      message.chainID,
    );

    let rawTx: TxRaw;
    if (isOfflineDirectSigner(signer)) {
      rawTx = await this.signMultiChainMessageDirect({
        signerAddress,
        signer,
        multiChainMessage: message,
        fee,
        signerData: {
          accountNumber,
          sequence,
          chainId: message.chainID,
        },
      });
    } else {
      rawTx = await this.signMultiChainMessageAmino({
        signerAddress,
        signer,
        multiChainMessage: message,
        fee,
        signerData: {
          accountNumber,
          sequence,
          chainId: message.chainID,
        },
      });
    }

    const txBytes = TxRaw.encode(rawTx).finish();

    const tx = await stargateClient.broadcastTx(txBytes);

    return tx;
  }

  async executeEVMTransaction({
    message,
    signer,
  }: {
    message: types.EvmTx;
    signer: WalletClient;
  }) {
    if (!signer.account) {
      throw new Error(
        "executeEVMTransaction error: failed to retrieve account from signer",
      );
    }

    const extendedSigner = signer.extend(publicActions);

    // check for approvals
    for (const requiredApproval of message.requiredERC20Approvals) {
      const allowance = await extendedSigner.readContract({
        address: requiredApproval.tokenContract as `0x${string}`,
        abi: erc20ABI,
        functionName: "allowance",
        args: [
          signer.account.address as `0x${string}`,
          requiredApproval.spender as `0x${string}`,
        ],
      });

      if (allowance > BigInt(requiredApproval.amount)) {
        continue;
      }

      const txHash = await extendedSigner.writeContract({
        account: signer.account,
        address: requiredApproval.tokenContract as `0x${string}`,
        abi: erc20ABI,
        functionName: "approve",
        args: [requiredApproval.spender as `0x${string}`, maxUint256],
        chain: signer.chain,
      });

      const receipt = await extendedSigner.waitForTransactionReceipt({
        hash: txHash,
      });

      if (receipt.status === "reverted") {
        throw new Error(
          `executeEVMTransaction error: evm tx reverted for hash ${receipt.transactionHash}`,
        );
      }
    }

    // execute tx
    const txHash = await extendedSigner.sendTransaction({
      account: signer.account,
      to: message.to as `0x${string}`,
      data: `0x${message.data}`,
      chain: signer.chain,
      value: message.value === "" ? undefined : BigInt(message.value),
    });

    const receipt = await extendedSigner.waitForTransactionReceipt({
      hash: txHash,
    });

    return receipt;
  }

  async signMultiChainMessageDirect(
    options: clientTypes.SignMultiChainMessageDirectOptions,
  ): Promise<TxRaw> {
    const {
      signer,
      signerAddress,
      multiChainMessage,
      fee,
      signerData: { accountNumber, sequence, chainId },
    } = options;

    if (multiChainMessage.chainID.includes("evmos")) {
      return this.signMultiChainMessageDirectEvmos(
        signerAddress,
        signer,
        multiChainMessage,
        fee,
        { accountNumber, sequence, chainId },
      );
    }

    if (multiChainMessage.chainID.includes("injective")) {
      return this.signMultiChainMessageDirectInjective(
        signerAddress,
        signer,
        multiChainMessage,
        fee,
        { accountNumber, sequence, chainId },
      );
    }

    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error(
        "signMultiChainMessageDirect error: failed to retrieve account from signer",
      );
    }

    const message = getEncodeObjectFromMultiChainMessage(multiChainMessage);

    const txBodyEncodeObject: TxBodyEncodeObject = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: {
        messages: [message],
      },
    };

    const txBodyBytes = this.registry.encode(txBodyEncodeObject);

    const gasLimit = Int53.fromString(fee.gas).toNumber();

    const pubkeyAny = makePubkeyAnyFromAccount(
      accountFromSigner,
      multiChainMessage.chainID,
    );

    const authInfoBytes = makeAuthInfoBytes(
      [{ pubkey: pubkeyAny, sequence }],
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

  // TODO: This is previously existing code, just moved to a new function.
  // Using signMultiChainMessageDirect on evmos DOES currently fail.
  // I need to investigate what exactly is even different about this and hopefully remove it all together.
  private async signMultiChainMessageDirectEvmos(
    signerAddress: string,
    signer: OfflineDirectSigner,
    multiChainMessage: types.MultiChainMsg,
    fee: StdFee,
    { accountNumber, sequence, chainId }: SignerData,
  ): Promise<TxRaw> {
    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error(
        "signMultiChainMessageDirectEvmos: failed to retrieve account from signer",
      );
    }

    const message =
      getEncodeObjectFromMultiChainMessageInjective(multiChainMessage);

    const pk = Buffer.from(accountFromSigner.pubkey).toString("base64");

    const { signDoc } = createTransaction({
      pubKey: pk,
      chainId: chainId,
      message: [message],
      sequence,
      accountNumber,
      timeoutHeight: 0,
      fee,
    });

    const directSignResponse = await signer.signDirect(
      signerAddress,
      // @ts-expect-error TODO: Fix this
      signDoc,
    );

    return TxRaw.fromPartial({
      bodyBytes: directSignResponse.signed.bodyBytes,
      authInfoBytes: directSignResponse.signed.authInfoBytes,
      signatures: [fromBase64(directSignResponse.signature.signature)],
    });
  }

  // TODO: This is previously existing code, just moved to a new function.
  // Using signMultiChainMessageDirect on injective DOES currently fail.
  // I need to investigate what exactly is even different about this and hopefully remove it all together.
  private async signMultiChainMessageDirectInjective(
    signerAddress: string,
    signer: OfflineDirectSigner,
    multiChainMessage: types.MultiChainMsg,
    fee: StdFee,
    { accountNumber, sequence, chainId }: SignerData,
  ): Promise<TxRaw> {
    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error(
        "signMultiChainMessageDirectInjective: failed to retrieve account from signer",
      );
    }

    const restEndpoint = await this.getRestEndpointForChain(
      multiChainMessage.chainID,
    );

    /** Block Details */
    const chainRestTendermintApi = new ChainRestTendermintApi(restEndpoint);
    const latestBlock = await chainRestTendermintApi.fetchLatestBlock();
    const latestHeight = latestBlock.header.height;
    const timeoutHeight = new BigNumberInBase(latestHeight).plus(
      DEFAULT_BLOCK_TIMEOUT_HEIGHT,
    );

    const pk = Buffer.from(accountFromSigner.pubkey).toString("base64");

    const message =
      getEncodeObjectFromMultiChainMessageInjective(multiChainMessage);

    const { signDoc } = createTransaction({
      pubKey: pk,
      chainId: chainId,
      message: [message],
      sequence,
      accountNumber,
      timeoutHeight: timeoutHeight.toNumber(),
      fee,
    });

    const directSignResponse = await signer.signDirect(
      signerAddress,
      // @ts-expect-error TODO: Fix this
      signDoc,
    );

    return TxRaw.fromPartial({
      bodyBytes: directSignResponse.signed.bodyBytes,
      authInfoBytes: directSignResponse.signed.authInfoBytes,
      signatures: [fromBase64(directSignResponse.signature.signature)],
    });
  }

  async signMultiChainMessageAmino(
    options: clientTypes.SignMultiChainMessageAminoOptions,
  ): Promise<TxRaw> {
    const {
      signer,
      signerAddress,
      multiChainMessage,
      fee,
      signerData: { accountNumber, sequence, chainId },
    } = options;

    const accounts = await signer.getAccounts();
    const accountFromSigner = accounts.find(
      (account) => account.address === signerAddress,
    );

    if (!accountFromSigner) {
      throw new Error(
        "signMultiChainMessageAmino: failed to retrieve account from signer",
      );
    }

    const message = getEncodeObjectFromMultiChainMessage(multiChainMessage);

    if (message.typeUrl === "/ibc.applications.transfer.v1.MsgTransfer") {
      const endpoint = await this.getRpcEndpointForChain(
        multiChainMessage.chainID,
      );

      const client = await StargateClient.connect(endpoint, {
        accountParser,
      });

      const currentHeight = await client.getHeight();

      message.value.timeoutHeight = {
        revisionHeight: Long.fromNumber(currentHeight).add(100),
        revisionNumber: Long.fromNumber(currentHeight).add(100),
      };

      message.value.timeoutTimestamp = Long.fromNumber(0);
    }

    const signMode = SignMode.SIGN_MODE_LEGACY_AMINO_JSON;
    const msgs = [this.aminoTypes.toAmino(message)];

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

    signedTxBody.messages[0]!.value.memo = message.value.memo;

    const signedTxBodyEncodeObject: TxBodyEncodeObject = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: signedTxBody,
    };

    const signedTxBodyBytes = this.registry.encode(signedTxBodyEncodeObject);

    const signedGasLimit = Int53.fromString(signed.fee.gas).toNumber();
    const signedSequence = Int53.fromString(signed.sequence).toNumber();

    const pubkeyAny = makePubkeyAnyFromAccount(
      accountFromSigner,
      multiChainMessage.chainID,
    );

    const signedAuthInfoBytes = makeAuthInfoBytes(
      [{ pubkey: pubkeyAny, sequence: signedSequence }],
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

  async messages(options: types.MsgsRequest): Promise<types.Msg[]> {
    const response = await this.requestClient.post<
      types.MsgsResponseJSON,
      types.MsgsRequestJSON
    >("/v2/fungible/msgs", {
      ...types.msgsRequestToJSON(options),
      slippage_tolerance_percent: options.slippageTolerancePercent || "0",
      client_id: this.clientID,
    });

    return response.msgs.map((msg) => types.msgFromJSON(msg));
  }

  async route(options: types.RouteRequest): Promise<types.RouteResponse> {
    const response = await this.requestClient.post<
      types.RouteResponseJSON,
      types.RouteRequestJSON
    >("/v2/fungible/route", {
      ...types.routeRequestToJSON(options),
      cumulative_affiliate_fee_bps: options.cumulativeAffiliateFeeBPS || "0",
      client_id: this.clientID,
    });

    return types.routeResponseFromJSON(response);
  }

  async recommendAssets(
    request:
      | types.AssetRecommendationRequest
      | types.AssetRecommendationRequest[],
  ) {
    const options = types.recommendAssetsRequestToJSON({
      requests: Array.isArray(request) ? request : [request],
      clientID: this.clientID,
    });

    const response =
      await this.requestClient.post<types.RecommendAssetsResponseJSON>(
        "/v2/fungible/recommend_assets",
        options,
      );

    return types.recommendAssetsResponseFromJSON(response)
      .recommendationEntries;
  }

  async ibcOriginAssets(
    assets: types.DenomWithChainID[],
  ): Promise<types.AssetOrError[]> {
    const response =
      await this.requestClient.post<types.OriginAssetsResponseJSON>(
        "/v2/fungible/ibc_origin_assets",
        types.originAssetsRequestToJSON({
          assets,
        }),
      );

    return types.originAssetsResponseFromJSON(response).originAssets;
  }

  async submitTransaction({
    chainID,
    tx,
  }: {
    chainID: string;
    tx: string;
  }): Promise<types.SubmitTxResponse> {
    const response = await this.requestClient.post<
      types.SubmitTxResponseJSON,
      types.SubmitTxRequestJSON
    >("/v2/tx/submit", {
      chain_id: chainID,
      tx: tx,
      client_id: this.clientID,
    });

    return types.submitTxResponseFromJSON(response);
  }

  async trackTransaction({
    chainID,
    txHash,
  }: {
    chainID: string;
    txHash: string;
  }): Promise<types.TrackTxResponse> {
    const response = await this.requestClient.post<
      types.TrackTxResponseJSON,
      types.TrackTxRequestJSON
    >("/v2/tx/track", {
      chain_id: chainID,
      tx_hash: txHash,
      client_id: this.clientID,
    });

    return types.trackTxResponseFromJSON(response);
  }

  async transactionStatus({
    chainID,
    txHash,
  }: {
    chainID: string;
    txHash: string;
  }): Promise<types.TxStatusResponse> {
    const response = await this.requestClient.get<
      types.TxStatusResponseJSON,
      types.StatusRequestJSON
    >("/v2/tx/status", {
      chain_id: chainID,
      tx_hash: txHash,
      client_id: this.clientID,
    });

    return types.txStatusResponseFromJSON(response);
  }

  async waitForTransaction({
    chainID,
    txHash,
    onTransactionTracked,
  }: {
    chainID: string;
    txHash: string;
    onTransactionTracked?: (txInfo: {
      txHash: string;
      chainID: string;
    }) => Promise<void>;
  }) {
    await this.trackTransaction({
      chainID,
      txHash,
    });
    if (onTransactionTracked) {
      await onTransactionTracked({ txHash, chainID });
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const txStatusResponse = await this.transactionStatus({
        chainID,
        txHash,
      });

      if (txStatusResponse.status === "STATE_COMPLETED") {
        return txStatusResponse;
      }

      await wait(1000);
    }
  }

  async venues(): Promise<types.SwapVenue[]> {
    const response = await this.requestClient.get<{
      venues: types.SwapVenueJSON[];
    }>("/v1/fungible/venues", {
      client_id: this.clientID,
    });

    return response.venues.map((venue) => types.swapVenueFromJSON(venue));
  }

  async getGasAmountForMessage(
    client: SigningCosmWasmClient,
    signerAddress: string,
    message: types.MultiChainMsg,
  ): Promise<string> {
    return getGasAmountForMessage(client, signerAddress, message);
  }

  async getAccountNumberAndSequence(address: string, chainID: string) {
    if (chainID.includes("dymension")) {
      return this.getAccountNumberAndSequenceFromDymension(address, chainID);
    }
    const endpoint = await this.getRpcEndpointForChain(chainID);
    const client = await StargateClient.connect(endpoint, {
      accountParser,
    });
    const account = await client.getAccount(address);
    if (!account) {
      throw new Error(
        "getAccountNumberAndSequence: failed to retrieve account",
      );
    }

    client.disconnect();

    return {
      accountNumber: account.accountNumber,
      sequence: account.sequence,
    };
  }

  private async getAccountNumberAndSequenceFromDymension(
    address: string,
    chainID: string,
  ) {
    const endpoint = await this.getRestEndpointForChain(chainID);

    const response = await axios.get(
      `${endpoint}/cosmos/auth/v1beta1/accounts/${address}`,
    );
    let sequence = 0;
    let accountNumber = 0;
    if (response.data.account.base_account) {
      sequence = response.data.account.base_account.sequence as number;
      accountNumber = response.data.account.base_account
        .account_number as number;
    } else {
      sequence = response.data.account.sequence as number;
      accountNumber = response.data.account.account_number as number;
    }
    return {
      accountNumber,
      sequence,
    };
  }

  private async getAccountNumberAndSequenceFromEvmos(
    address: string,
    chainID: string,
  ) {
    const endpoint = await this.getRestEndpointForChain(chainID);

    const response = await axios.get(
      `${endpoint}/cosmos/auth/v1beta1/accounts/${address}`,
    );

    const accountNumber = response.data.account.base_account
      .account_number as number;
    const sequence = response.data.account.base_account.sequence as number;

    return {
      accountNumber,
      sequence,
    };
  }

  private async getAccountNumberAndSequenceInjective(
    address: string,
    chainID: string,
  ) {
    const endpoint = await this.getRestEndpointForChain(chainID);

    const chainRestAuthApi = new ChainRestAuthApi(endpoint);

    const accountDetailsResponse = await chainRestAuthApi.fetchAccount(address);

    return {
      accountNumber: parseInt(
        accountDetailsResponse.account.base_account.account_number,
      ),
      sequence: parseInt(accountDetailsResponse.account.base_account.sequence),
    };
  }

  private async getRpcEndpointForChain(chainID: string) {
    if (this.endpointOptions.getRpcEndpointForChain) {
      return this.endpointOptions.getRpcEndpointForChain(chainID);
    }

    if (
      this.endpointOptions.endpoints &&
      this.endpointOptions.endpoints[chainID]
    ) {
      const endpointOptions = this.endpointOptions.endpoints[chainID];

      if (endpointOptions?.rpc) {
        return endpointOptions.rpc;
      }
    }

    const chain = chains().find((chain) => chain.chain_id === chainID);

    if (!chain) {
      throw new Error(
        `getRpcEndpointForChain: failed to find chain id '${chainID}' in registry`,
      );
    }

    const endpoint = chain.apis?.rpc?.[0]?.address;

    if (!endpoint) {
      throw new Error(
        `getRpcEndpointForChain error: failed to find RPC endpoint for chain '${chainID}'`,
      );
    }

    return endpoint;
  }

  private async getRestEndpointForChain(chainID: string) {
    if (this.endpointOptions.getRestEndpointForChain) {
      return this.endpointOptions.getRestEndpointForChain(chainID);
    }

    if (
      this.endpointOptions.endpoints &&
      this.endpointOptions.endpoints[chainID]
    ) {
      const endpointOptions = this.endpointOptions.endpoints[chainID];

      if (endpointOptions?.rest) {
        return endpointOptions.rest;
      }
    }

    const chain = chains().find((chain) => chain.chain_id === chainID);
    if (!chain) {
      throw new Error(
        `getRestEndpointForChain error: failed to find chain id '${chainID}' in registry`,
      );
    }

    const endpoint = chain.apis?.rest?.[0]?.address;

    if (!endpoint) {
      throw new Error(
        `getRestEndpointForChain error: failed to find REST endpoint for chain '${chainID}'`,
      );
    }

    return endpoint;
  }

  async getFeeForMessage(
    msg: types.MultiChainMsg,
    gasAmountMultiplier: number = DEFAULT_GAS_MULTIPLIER,
    signer?: OfflineSigner,
    gasPrice?: GasPrice,
  ) {
    gasPrice ||= await this.getRecommendedGasPrice(msg.chainID);
    if (!gasPrice) {
      throw new Error(
        `getFeeForMessage error: Unable to get gas price for chain: ${msg.chainID}`,
      );
    }

    signer ||= await this.getCosmosSigner?.(msg.chainID);
    if (!signer) {
      throw new Error(
        "getFeeForMessage error: signer is not provided or 'getCosmosSigner' is not configured in skip router",
      );
    }

    const accounts = await signer.getAccounts();
    const signerAddress =
      accounts[0]?.address ||
      raise(
        `getFeeForMessage error: unable to resolve account address from signer`,
      );

    const endpoint = await this.getRpcEndpointForChain(msg.chainID);

    const client = await SigningCosmWasmClient.connectWithSigner(
      endpoint,
      signer,
      {
        aminoTypes: this.aminoTypes,
        registry: this.registry,
      },
    );

    const gasNeeded = await getGasAmountForMessage(
      client,
      signerAddress,
      msg,
      gasAmountMultiplier,
    );

    const fee = calculateFee(Math.ceil(parseFloat(gasNeeded)), gasPrice);

    if (!fee) {
      throw new Error("getFeeForMessage error: unable to get fee for message");
    }

    return fee;
  }

  async getRecommendedGasPrice(chainID: string) {
    const feeInfo = await this.getFeeInfoForChain(chainID);

    if (!feeInfo) {
      return undefined;
    }

    let price = feeInfo.gasPrice.average;
    if (price === "") {
      price = feeInfo.gasPrice.high;
    }
    if (price === "") {
      price = feeInfo.gasPrice.low;
    }

    return new GasPrice(Decimal.fromUserInput(price, 18), feeInfo.denom);
  }

  async getFeeInfoForChain(
    chainID: string,
  ): Promise<types.FeeAsset | undefined> {
    const skipChains = await this.chains();

    const skipChain = skipChains.find((chain) => chain.chainID === chainID);

    if (!skipChain) {
      return undefined;
    }

    const defaultGasToken = await this.getDefaultGasTokenForChain(chainID);

    if (!defaultGasToken && !skipChain.feeAssets) {
      return undefined;
    }

    const skipFeeInfo = defaultGasToken
      ? skipChain.feeAssets.find((skipFee) => skipFee.denom === defaultGasToken)
      : skipChain.feeAssets[0];

    if (skipFeeInfo && skipFeeInfo.gasPrice !== null) {
      return skipFeeInfo;
    }

    const chain = chains().find((chain) => chain.chain_id === chainID);
    if (!chain) {
      return undefined;
    }

    if (!chain.fees) {
      return undefined;
    }

    const registryFeeInfo = chain.fees.fee_tokens.find(
      (feeToken) => feeToken.denom === defaultGasToken,
    );

    if (!registryFeeInfo) {
      return undefined;
    }

    return {
      denom: registryFeeInfo.denom,
      gasPrice: {
        low: registryFeeInfo.low_gas_price
          ? `${registryFeeInfo.low_gas_price}`
          : "",
        average: registryFeeInfo.average_gas_price
          ? `${registryFeeInfo.average_gas_price}`
          : "",
        high: registryFeeInfo.high_gas_price
          ? `${registryFeeInfo.high_gas_price}`
          : "",
      },
    };
  }

  private getDefaultGasTokenForChain(chainID: string) {
    const gasDenom = DEFAULT_GAS_DENOM_OVERRIDES[chainID];
    if (gasDenom) {
      return gasDenom;
    }

    const chain = chains().find((chain) => chain.chain_id === chainID);
    if (!chain) {
      return undefined;
    }

    if (!chain.fees) {
      return undefined;
    }

    // first check if the chain has a staking token, this is often the "default" gas token
    const stakingTokens = this.getStakingTokensForChain(chainID);
    if (stakingTokens && stakingTokens.length > 0) {
      const feeAsset = chain.fees.fee_tokens.find(
        (feeToken) => feeToken.denom === stakingTokens[0]?.denom,
      );

      if (feeAsset) {
        return feeAsset.denom;
      }
    }

    // next attempt to get the first non-IBC asset in the fee_tokens array, at least this token will be native to the chain
    const nonIBCAsset = chain.fees.fee_tokens.find(
      (token) => !token.denom.startsWith("ibc/"),
    );
    if (nonIBCAsset) {
      return nonIBCAsset.denom;
    }

    // if all else fails, just return the first token in the array
    return chain.fees.fee_tokens[0]?.denom;
  }

  private getStakingTokensForChain(chainID: string) {
    const chain = chains().find((chain) => chain.chain_id === chainID);
    if (!chain) {
      throw new Error(
        `getStakingTokensForChain error: failed to find chain id '${chainID}' in registry`,
      );
    }

    if (!chain.staking) {
      return undefined;
    }

    return chain.staking.staking_tokens;
  }

  private async validateGasBalances(
    messages: types.Msg[],
    userAddresses: Record<string, string>,
    getOfflineSigner: (chainID: string) => Promise<OfflineSigner>,
    getGasPrice?: (chainID: string) => Promise<GasPrice | undefined>,
    gasAmountMultiplier?: number,
  ) {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;

      if ("multiChainMsg" in message) {
        const signer = await getOfflineSigner(message.multiChainMsg.chainID);

        const endpoint = await this.getRpcEndpointForChain(
          message.multiChainMsg.chainID,
        );
        const client = await SigningCosmWasmClient.connectWithSigner(
          endpoint,
          signer,
          {
            aminoTypes: this.aminoTypes,
            registry: this.registry,
          },
        );

        const currentAddress =
          userAddresses[message.multiChainMsg.chainID] ||
          raise(
            `validateGasBalance error: invalid address for chain '${message.multiChainMsg.chainID}'`,
          );

        await this.validateCosmosGasBalance(
          client,
          signer,
          currentAddress,
          message.multiChainMsg,
          getGasPrice,
          gasAmountMultiplier,
        );
      }
    }
  }

  private async validateCosmosGasBalance(
    client: SigningCosmWasmClient,
    signer: OfflineSigner,
    signerAddress: string,
    message: types.MultiChainMsg,
    getGasPrice?: (chainID: string) => Promise<GasPrice | undefined>,
    gasAmountMultiplier?: number,
  ) {
    let gasPrice: GasPrice | undefined;
    if (getGasPrice) {
      gasPrice = await getGasPrice(message.chainID);
    }

    const fee = await this.getFeeForMessage(
      message,
      gasAmountMultiplier,
      signer,
      gasPrice,
    );

    if (!fee.amount[0]) {
      throw new Error(
        `validateCosmosGasBalance error: unable to get fee amount`,
      );
    }

    const balance = await client.getBalance(signerAddress, fee.amount[0].denom);

    if (parseInt(balance.amount) < parseInt(fee.amount[0].amount)) {
      throw new Error(
        `Insufficient fee token to initiate transfer on ${
          message.chainID
        }. Need ${parseInt(fee.amount[0].amount)} ${
          fee.amount[0].denom
        }, but only have ${balance.amount} ${fee.amount[0].denom}.`,
      );
    }
  }
}

function raise(message?: string, options?: ErrorOptions): never {
  throw new Error(message, options);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
