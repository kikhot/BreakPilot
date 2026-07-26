import assert from "node:assert/strict";
import test from "node:test";

import { DapSession } from "../src/dap/DapSession.ts";
import { VariableSerializer } from "../src/inspection/VariableSerializer.ts";
import type { AnyRecord } from "../src/types/json.ts";

const parentVariable = {
  name: "parent",
  value: "Parent@1",
  type: "Parent",
  variablesReference: 10,
  namedVariables: 3
};

const ignoredLimitChildren = [
  { name: "first", value: "1", type: "int", variablesReference: 0 },
  { name: "second", value: "2", type: "int", variablesReference: 0 },
  { name: "third", value: "3", type: "int", variablesReference: 0 }
];

function serializerWithLimitIgnoringAdapter(): VariableSerializer {
  const session = Object.create(DapSession.prototype) as DapSession;
  session.capabilities = {};
  session.client = {
    async request(command: string, args: AnyRecord) {
      assert.equal(command, "variables");
      assert.equal(args.variablesReference, 10);
      assert.equal(args.count, 1);
      return { variables: ignoredLimitChildren };
    }
  } as any;
  return new VariableSerializer(session, {
    maxDepth: 2,
    maxItems: 1,
    maxStringLength: 100,
    redactPatterns: []
  });
}

function serializerReturning(
  children: typeof ignoredLimitChildren,
  maxItems: number,
  maxStringLength = 100
): VariableSerializer {
  const session = Object.create(DapSession.prototype) as DapSession;
  session.capabilities = {};
  session.client = {
    async request(_command: string, args: AnyRecord) {
      assert.equal(args.count, maxItems);
      return { variables: children };
    }
  } as any;
  return new VariableSerializer(session, {
    maxDepth: 2,
    maxItems,
    maxStringLength,
    redactPatterns: []
  });
}

test("variable nodes report the children BreakPilot capped as incomplete", async () => {
  const node = await serializerWithLimitIgnoringAdapter().serializeVariableNode(parentVariable);

  assert.deepEqual(node.children?.map((child) => child.name), ["first", "__truncated__"]);
  assert.equal(node.childrenCount, 3);
  assert.equal(node.complete, false);
  assert.equal(node.truncated, true);
});

test("serialized variable maps report the children BreakPilot capped as incomplete", async () => {
  const variable = await serializerWithLimitIgnoringAdapter().serializeVariable(parentVariable);
  const exposed = variable.value as Record<string, unknown>;

  assert.deepEqual(Object.keys(exposed), ["first", "__truncated__"]);
  assert.equal(variable.childrenCount, 3);
  assert.equal(variable.complete, false);
  assert.equal(variable.truncated, true);
});

test("unknown child counts remain unknown when BreakPilot does not cap the response", async () => {
  const session = Object.create(DapSession.prototype) as DapSession;
  session.capabilities = {};
  session.client = {
    async request() {
      return { variables: [ignoredLimitChildren[0]] };
    }
  } as any;
  const serializer = new VariableSerializer(session, {
    maxDepth: 2,
    maxItems: 3,
    maxStringLength: 100,
    redactPatterns: []
  });
  const unknownCountParent = {
    name: "parent",
    value: "Parent@1",
    type: "Parent",
    variablesReference: 10
  };

  const node = await serializer.serializeVariableNode(unknownCountParent);
  const variable = await serializer.serializeVariable(unknownCountParent);

  assert.equal(node.complete, undefined);
  assert.equal(node.truncated, false);
  assert.equal(variable.complete, undefined);
  assert.equal(variable.truncated, false);
});

test("duplicate variable names make keyed map exposure incomplete", async () => {
  const children = [
    { name: "duplicate", value: "1", type: "int", variablesReference: 0 },
    { name: "duplicate", value: "2", type: "int", variablesReference: 0 }
  ];
  const parent = { ...parentVariable, namedVariables: 2 };

  const variable = await serializerReturning(children, 10).serializeVariable(parent);

  assert.deepEqual(Object.keys(variable.value as AnyRecord), ["duplicate"]);
  assert.equal(variable.complete, false);
  assert.equal(variable.truncated, true);
});

test("node arrays remain complete when duplicate names are all exposed", async () => {
  const children = [
    { name: "duplicate", value: "1", type: "int", variablesReference: 0 },
    { name: "duplicate", value: "2", type: "int", variablesReference: 0 }
  ];
  const parent = { ...parentVariable, namedVariables: 2 };

  const node = await serializerReturning(children, 10).serializeVariableNode(parent);

  assert.deepEqual(node.children?.map((child) => child.name), ["duplicate", "duplicate"]);
  assert.equal(node.complete, true);
  assert.equal(node.truncated, false);
});

test("a capped child named __truncated__ cannot create a false complete map", async () => {
  const children = [
    { name: "__truncated__", value: "user value", type: "str", variablesReference: 0 },
    { name: "second", value: "2", type: "int", variablesReference: 0 }
  ];
  const parent = { ...parentVariable, namedVariables: 2 };

  const variable = await serializerReturning(children, 1).serializeVariable(parent);
  const exposed = variable.value as AnyRecord;

  assert.deepEqual(Object.keys(exposed), ["__truncated__"]);
  assert.equal((exposed.__truncated__ as AnyRecord).kind, "metadata");
  assert.equal(variable.complete, false);
  assert.equal(variable.truncated, true);
});

test("__proto__ is serialized as a safe own variable property", async () => {
  const children = [
    { name: "__proto__", value: "safe", type: "str", variablesReference: 0 }
  ];
  const parent = { ...parentVariable, namedVariables: 1 };

  const variable = await serializerReturning(children, 10).serializeVariable(parent);
  const exposed = variable.value as AnyRecord;

  assert.equal(Object.getPrototypeOf(exposed), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(exposed, "__proto__"), true);
  assert.equal((exposed.__proto__ as AnyRecord).name, "__proto__");
  assert.equal(variable.complete, true);
  assert.equal(variable.truncated, false);
});

test("long primitive values mark both node and map serializations incomplete", async () => {
  const serializer = serializerReturning([], 10, 3);
  const variable = { name: "long", value: "abcdef", type: "str", variablesReference: 0 };

  const node = await serializer.serializeVariableNode(variable);
  const mapped = await serializer.serializeVariable(variable);

  assert.equal(node.summary, "abc...");
  assert.equal(node.raw, "abc...");
  assert.equal(node.truncated, true);
  assert.equal(node.complete, false);
  assert.equal(mapped.valuePreview, "abc...");
  assert.equal(mapped.value, "abc...");
  assert.equal(mapped.truncated, true);
  assert.equal(mapped.complete, false);
});

test("long reference summaries remain incomplete after complete empty children", async () => {
  const serializer = serializerReturning([], 10, 3);
  const variable = {
    name: "parent",
    value: "abcdef",
    type: "Parent",
    variablesReference: 10,
    namedVariables: 0
  };

  const node = await serializer.serializeVariableNode(variable);
  const mapped = await serializer.serializeVariable(variable);

  assert.deepEqual(node.children, []);
  assert.equal(node.summary, "abc...");
  assert.equal(node.truncated, true);
  assert.equal(node.complete, false);
  assert.deepEqual(mapped.value, {});
  assert.equal(mapped.valuePreview, "abc...");
  assert.equal(mapped.truncated, true);
  assert.equal(mapped.complete, false);
});

test("long reference summaries remain incomplete after complete returned children", async () => {
  const serializer = serializerReturning([
    { name: "child", value: "1", type: "int", variablesReference: 0 }
  ], 10, 3);
  const variable = {
    name: "parent",
    value: "abcdef",
    type: "Parent",
    variablesReference: 10,
    namedVariables: 1
  };

  const node = await serializer.serializeVariableNode(variable);
  const mapped = await serializer.serializeVariable(variable);

  assert.deepEqual(node.children?.map((child) => child.name), ["child"]);
  assert.equal(node.truncated, true);
  assert.equal(node.complete, false);
  assert.deepEqual(Object.keys(mapped.value as AnyRecord), ["child"]);
  assert.equal(mapped.truncated, true);
  assert.equal(mapped.complete, false);
});

test("a clipped primitive descendant makes short node and map parents incomplete", async () => {
  const serializer = serializerReturning([
    { name: "child", value: "abcdef", type: "str", variablesReference: 0 }
  ], 10, 3);
  const variable = {
    name: "parent",
    value: "obj",
    type: "Parent",
    variablesReference: 10,
    namedVariables: 1
  };

  const node = await serializer.serializeVariableNode(variable);
  const mapped = await serializer.serializeVariable(variable);
  const mappedChild = (mapped.value as AnyRecord).child as AnyRecord;

  assert.equal(node.children?.[0]?.summary, "abc...");
  assert.equal(node.children?.[0]?.complete, false);
  assert.equal(node.children?.[0]?.truncated, true);
  assert.equal(node.complete, false);
  assert.equal(node.truncated, true);
  assert.equal(mappedChild.valuePreview, "abc...");
  assert.equal(mappedChild.complete, false);
  assert.equal(mappedChild.truncated, true);
  assert.equal(mapped.complete, false);
  assert.equal(mapped.truncated, true);
});

test("unknown descendant completeness prevents short parents from claiming complete", async () => {
  const session = Object.create(DapSession.prototype) as DapSession;
  session.capabilities = {};
  session.client = {
    async request(_command: string, args: AnyRecord) {
      if (args.variablesReference === 10) {
        return {
          variables: [{ name: "child", value: "obj", type: "Child", variablesReference: 20 }]
        };
      }
      assert.equal(args.variablesReference, 20);
      return {
        variables: [{ name: "leaf", value: "1", type: "int", variablesReference: 0 }]
      };
    }
  } as any;
  const serializer = new VariableSerializer(session, {
    maxDepth: 3,
    maxItems: 10,
    maxStringLength: 100,
    redactPatterns: []
  });
  const variable = {
    name: "parent",
    value: "obj",
    type: "Parent",
    variablesReference: 10,
    namedVariables: 1
  };

  const node = await serializer.serializeVariableNode(variable);
  const mapped = await serializer.serializeVariable(variable);

  assert.equal(node.children?.[0]?.complete, undefined);
  assert.equal(node.complete, undefined);
  assert.equal(Object.hasOwn(node, "complete"), false);
  assert.equal(node.truncated, false);
  assert.equal(((mapped.value as AnyRecord).child as AnyRecord).complete, undefined);
  assert.equal(mapped.complete, undefined);
  assert.equal(Object.hasOwn(mapped, "complete"), false);
  assert.equal(mapped.truncated, false);
});

test("short values retain complete serialization", async () => {
  const serializer = serializerReturning([], 10, 3);
  const variable = { name: "short", value: "abc", type: "str", variablesReference: 0 };

  const node = await serializer.serializeVariableNode(variable);
  const mapped = await serializer.serializeVariable(variable);

  assert.equal(node.summary, "abc");
  assert.equal(node.truncated, false);
  assert.equal(node.complete, true);
  assert.equal(mapped.valuePreview, "abc");
  assert.equal(mapped.truncated, false);
  assert.equal(mapped.complete, true);
});
