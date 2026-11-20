import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "alipay";

const tradeNo = s.string({
  minLength: 1,
  description: "Alipay transaction id (trade_no) assigned by Alipay, for example 2013112011001004330000121536.",
});
const outTradeNo = s.string({
  minLength: 1,
  maxLength: 64,
  description: "Merchant order number (out_trade_no) from the merchant's own order system.",
});

const tradeResultSchema = s.object(
  "One Alipay trade returned by the open API query, with the settlement state the reconciliation needs.",
  {
    result: s.looseObject(
      {},
      { description: "The raw alipay.trade.query response object as returned by the gateway." },
    ),
    tradeNo: s.nullableString("The Alipay transaction id (trade_no), or null when absent."),
    outTradeNo: s.nullableString("The merchant order number (out_trade_no), or null when absent."),
    tradeStatus: s.nullableString(
      "The trade status (trade_status): WAIT_BUYER_PAY, TRADE_CLOSED, TRADE_SUCCESS or TRADE_FINISHED.",
    ),
    totalAmount: s.nullableString("The order amount (total_amount) in yuan, or null when absent."),
    sendPayDate: s.nullableString("The payment time (send_pay_date) in yyyy-MM-dd HH:mm:ss, or null when absent."),
  },
  { required: ["result"] },
);

const downloadedBillSchema = s.requiredObject(
  "One downloaded Alipay settlement bill stored in local transit storage.",
  {
    billDate: s.string({ format: "date", description: "The requested settlement date (bill_date), YYYY-MM-DD." }),
    billType: s.stringEnum(["trade", "signcustomer"], {
      description: "The requested bill type: trade merchant order bill, signcustomer merchant settlement bill.",
    }),
    billDownloadUrl: s.url("The Alipay bill download URL the gateway issued for this request."),
    name: s.nonEmptyString("The filename used for the local transit file."),
    mimeType: s.nonEmptyString("The MIME type of the downloaded bill archive."),
    sizeBytes: s.nonNegativeInteger("The downloaded bill archive size in bytes."),
    entries: s.stringArray("The file names inside the downloaded bill archive."),
    file: s.requiredObject("The bill archive in local transit file storage.", {
      fileId: s.nonEmptyString("The local transit file identifier."),
      downloadUrl: s.url("The local transit URL for downloading the stored bill archive."),
      sizeBytes: s.nonNegativeInteger("The stored transit file size in bytes."),
      name: s.nonEmptyString("The stored transit file name."),
      mimeType: s.nonEmptyString("The stored transit file MIME type."),
    }),
  },
);

export const alipayActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "query_trade",
    operationType: "read",
    description:
      "Query one merchant trade by Alipay transaction id or merchant order number (alipay.trade.query). " +
      "Returns the trade status and amounts used for daily settlement reconciliation.",
    inputSchema: s.requireExactlyOneProperty(
      s.object(
        "Query one trade by exactly one of Alipay transaction id or merchant order number.",
        { tradeNo, outTradeNo },
        { optional: ["tradeNo", "outTradeNo"], description: "Query one Alipay trade." },
      ),
      ["tradeNo", "outTradeNo"],
    ),
    outputSchema: tradeResultSchema,
  }),
  defineProviderAction(service, {
    name: "download_settlement_bill",
    operationType: "read",
    description:
      "Request the settlement bill download URL for one day and download the bill archive " +
      "(alipay.data.dataservice.bill.downloadurl.query). The ZIP archive of CSV statements is stored in local " +
      "transit file storage for daily channel reconciliation.",
    inputSchema: s.object(
      "Request and download the settlement bill of one day.",
      {
        billDate: s.date(
          "The settlement date (bill_date) in YYYY-MM-DD. Only bills of the last three months are available.",
        ),
        billType: s.withDefault(
          s.stringEnum(["trade", "signcustomer"], {
            description: "The bill type (bill_type): trade merchant order bill, signcustomer merchant settlement bill.",
          }),
          "trade",
        ),
        fileName: s.nonEmptyString("An optional filename override for the local transit file."),
      },
      { optional: ["billType", "fileName"], description: "Download the Alipay settlement bill of one day." },
    ),
    outputSchema: downloadedBillSchema,
  }),
];
