import type { OperationScope, PolicyRules, TokenPolicy } from "../../core/action-policy.ts";
import type { JsonRequestBody } from "./http-utils.ts";

import { Buffer } from "node:buffer";
import { requiredStringArray } from "../../core/cast.ts";
import { HttpRequestError } from "./http-utils.ts";

export const policyRequestMaxBytes: number = 256 * 1024;
export const policyRuleMaxBytes: number = 256;
export const policyRuleListMaxItems: number = 128;

/** Closed set of catalog action classes a token may be scoped to (scoped-pat-grants D6). */
export const operationTypes = ["read", "write", "destructive"] as const;

export function readRuntimePolicyRules(body: JsonRequestBody): PolicyRules {
  return {
    allowedActions: readRules(body.allowedActions, "allowedActions", "action"),
    blockedActions: readRules(body.blockedActions, "blockedActions", "action"),
    allowedProxies: readRules(body.allowedProxies, "allowedProxies", "proxy"),
    blockedProxies: readRules(body.blockedProxies, "blockedProxies", "proxy"),
    allowedTriggers: readRules(body.allowedTriggers, "allowedTriggers", "action", true),
    blockedTriggers: readRules(body.blockedTriggers, "blockedTriggers", "action", true),
  };
}

export function readTokenPolicy(body: JsonRequestBody, allowOmitted = false): TokenPolicy {
  if (body.blockedTriggers !== undefined) {
    throw invalidInput("Token policy does not support Trigger block rules.");
  }
  if (body.blockedProxies !== undefined) {
    throw invalidInput("Token policy does not support proxy block rules.");
  }
  return {
    allowedActions: readRules(body.allowedActions, "allowedActions", "action", allowOmitted),
    blockedActions: readRules(body.blockedActions, "blockedActions", "action", allowOmitted),
    allowedProxies: readRules(body.allowedProxies, "allowedProxies", "proxy", allowOmitted),
    allowedTriggers: readRules(body.allowedTriggers, "allowedTriggers", "action", true),
    allowedConnections: readConnectionIds(body.allowedConnections, "allowedConnections", allowOmitted),
    // Optional everywhere: upstream callers never send it, and an absent class
    // scope is exactly the upstream meaning (no class-based grant).
    allowedOperations: readAllowedOperations(body.allowedOperations),
  };
}

/**
 * `allowedOperations: [{provider, operationType}]` — the structured scope unit.
 *
 * Kept as tuples rather than expanded into action ids: an id list both overflows
 * `policyRuleListMaxItems` on large providers and freezes the scope at mint time,
 * so a provider's new actions would silently fall outside a grant the user
 * already approved.
 */
function readAllowedOperations(value: unknown): OperationScope[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidInput("allowedOperations must be an array of {provider, operationType} objects.");
  }
  const scopes: OperationScope[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidInput("allowedOperations entries must be {provider, operationType} objects.");
    }
    const entry = item as { provider?: unknown; operationType?: unknown };
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (!provider || /[\s*]/.test(provider)) {
      throw invalidInput("allowedOperations entries need a provider service id (no spaces or wildcards).");
    }
    if (Buffer.byteLength(provider, "utf8") > policyRuleMaxBytes) {
      throw invalidInput(`allowedOperations provider ids must not exceed ${policyRuleMaxBytes} UTF-8 bytes.`);
    }
    if (typeof entry.operationType !== "string" || !(operationTypes as readonly string[]).includes(entry.operationType)) {
      throw invalidInput(`allowedOperations operationType must be one of: ${operationTypes.join(",")}.`);
    }
    const operationType = entry.operationType as (typeof operationTypes)[number];
    const key = `${provider}@${operationType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ provider, operationType });
  }
  if (scopes.length > policyRuleListMaxItems) {
    throw invalidInput(`allowedOperations must not contain more than ${policyRuleListMaxItems} entries.`);
  }
  return scopes;
}

function readRules(value: unknown, fieldName: string, kind: "action" | "proxy", allowOmitted = false): string[] {
  if (value === undefined && allowOmitted) {
    return [];
  }
  const values = requiredStringArray(value, fieldName, invalidInput);
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const rule = value.trim();
    if (!rule) {
      throw invalidInput(`${fieldName} must not contain empty rules.`);
    }
    if (Buffer.byteLength(rule, "utf8") > policyRuleMaxBytes) {
      throw invalidInput(`${fieldName} rules must not exceed ${policyRuleMaxBytes} UTF-8 bytes.`);
    }
    assertRuleSyntax(rule, fieldName, kind);
    if (!seen.has(rule)) {
      seen.add(rule);
      rules.push(rule);
    }
  }
  if (rules.length > policyRuleListMaxItems) {
    throw invalidInput(`${fieldName} must not contain more than ${policyRuleListMaxItems} rules.`);
  }
  return rules;
}

function readConnectionIds(value: unknown, fieldName: string, allowOmitted = false): string[] {
  if (value === undefined && allowOmitted) {
    return [];
  }
  const values = requiredStringArray(value, fieldName, invalidInput);
  const connectionIds: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const connectionId = item.trim();
    if (!connectionId) {
      throw invalidInput(`${fieldName} must not contain empty connection IDs.`);
    }
    if (Buffer.byteLength(connectionId, "utf8") > policyRuleMaxBytes) {
      throw invalidInput(`${fieldName} IDs must not exceed ${policyRuleMaxBytes} UTF-8 bytes.`);
    }
    if (!seen.has(connectionId)) {
      seen.add(connectionId);
      connectionIds.push(connectionId);
    }
  }
  if (connectionIds.length > policyRuleListMaxItems) {
    throw invalidInput(`${fieldName} must not contain more than ${policyRuleListMaxItems} rules.`);
  }
  return connectionIds;
}

function assertRuleSyntax(rule: string, fieldName: string, kind: "action" | "proxy"): void {
  if (rule === "*") {
    return;
  }
  if (kind === "proxy") {
    if (rule.includes("*") || /\s/.test(rule)) {
      throw invalidInput(`${fieldName} contains an invalid proxy rule: ${rule}.`);
    }
    return;
  }
  if (/^[^\s.*]+\.\*$/.test(rule)) {
    return;
  }
  const separator = rule.indexOf(".");
  if (rule.includes("*") || /\s/.test(rule) || separator <= 0 || separator === rule.length - 1) {
    throw invalidInput(`${fieldName} contains an invalid action rule: ${rule}.`);
  }
}

function invalidInput(message: string): HttpRequestError {
  return new HttpRequestError("invalid_input", message);
}
