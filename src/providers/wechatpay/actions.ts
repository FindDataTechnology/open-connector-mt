import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "wechatpay";

const transactionId = s.string({
  minLength: 1,
  description:
    "WeChat Pay transaction id (transaction_id) assigned by WeChat Pay, for example 4200001234202401010000000000.",
});
const outTradeNo = s.string({
  minLength: 1,
  maxLength: 32,
  description: "Merchant order number (out_trade_no) from the merchant's own order system.",
});

const transactionSchema = s.object(
  "One WeChat Pay transaction returned by the merchant API, with the payment state and amounts the reconciliation needs.",
  {
    transaction: s.looseObject({}, { description: "The raw WeChat Pay transaction object as returned by the API." }),
    transactionId: s.nullableString("The WeChat Pay transaction id (transaction_id), or null when absent."),
    outTradeNo: s.nullableString("The merchant order number (out_trade_no), or null when absent."),
    tradeState: s.nullableString("The payment state (trade_state), for example SUCCESS, REFUND, NOTPAY or CLOSED."),
    amountTotal: s.nullableInteger(
      "The order amount in the smallest currency unit (amount.total), or null when absent.",
    ),
    successTime: s.nullableString(
      "The payment completion time (success_time) in RFC 3339 format, or null when absent.",
    ),
  },
  { required: ["transaction"] },
);

const downloadedBillSchema = s.requiredObject("One downloaded WeChat Pay trade bill stored in local transit storage.", {
  billDate: s.string({ format: "date", description: "The requested settlement date (bill_date), YYYY-MM-DD." }),
  billType: s.stringEnum(["ALL", "SUCCESS", "REFUND"], {
    description: "The requested bill type (bill_type).",
  }),
  hashType: s.nullableString("The digest algorithm of the bill file (hash_type), or null when WeChat Pay omitted it."),
  hashValue: s.nullableString("The digest value of the bill file (hash_value), or null when WeChat Pay omitted it."),
  name: s.nonEmptyString("The filename used for the local transit file."),
  mimeType: s.nonEmptyString("The MIME type of the decompressed bill content."),
  sizeBytes: s.nonNegativeInteger("The decompressed bill content size in bytes."),
  file: s.requiredObject("The decompressed bill content in local transit file storage.", {
    fileId: s.nonEmptyString("The local transit file identifier."),
    downloadUrl: s.url("The local transit URL for downloading the stored bill content."),
    sizeBytes: s.nonNegativeInteger("The stored transit file size in bytes."),
    name: s.nonEmptyString("The stored transit file name."),
    mimeType: s.nonEmptyString("The stored transit file MIME type."),
  }),
});

export const wechatPayActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "query_transaction",
    operationType: "read",
    description:
      "Query one merchant transaction by WeChat Pay transaction id or merchant order number (merchant APIv3 查询订单). " +
      "Returns the payment state and amounts used for daily settlement reconciliation.",
    inputSchema: s.requireExactlyOneProperty(
      s.object(
        "Query one transaction by exactly one of transaction id or merchant order number.",
        { transactionId, outTradeNo },
        { optional: ["transactionId", "outTradeNo"], description: "Query one WeChat Pay transaction." },
      ),
      ["transactionId", "outTradeNo"],
    ),
    outputSchema: transactionSchema,
  }),
  defineProviderAction(service, {
    name: "download_bill",
    operationType: "read",
    description:
      "Download one settlement day's trade bill from WeChat Pay (merchant APIv3 申请交易账单 + 下载账单). " +
      "The bill is stored as decompressed CSV text in local transit file storage for daily channel reconciliation.",
    inputSchema: s.object(
      "Request and download the trade bill of one settlement day.",
      {
        billDate: s.date(
          "The settlement date (bill_date) in YYYY-MM-DD. Must be a past date within the retention window.",
        ),
        billType: s.withDefault(
          s.stringEnum(["ALL", "SUCCESS", "REFUND"], {
            description: "The bill type (bill_type): ALL all orders, SUCCESS paid orders, REFUND refunded orders.",
          }),
          "ALL",
        ),
        fileName: s.nonEmptyString("An optional filename override for the local transit file."),
      },
      { optional: ["billType", "fileName"], description: "Download the trade bill of one settlement day." },
    ),
    outputSchema: downloadedBillSchema,
  }),
];
