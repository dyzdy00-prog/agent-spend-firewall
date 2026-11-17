import { readEvm, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/evm.ts";
import { hashTypedData } from "viem";
import { td, ctx } from "./_h.ts";
const h = (t: any) => hashTypedData({ domain: t.domain, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: t.message });
const num = td(), str = td({ domain: { chainId: "84532" } }), big = td({ domain: { chainId: 84532n } });
console.log("reader accepts string chainId:", readEvm(str, ctx()).ok);
console.log("digest(number)==digest(bigint):", h(num) === h(big));
console.log("digest(number)==digest(string):", h(num) === h(str), "(false => viem drops chainId from the domain type for string values)");
