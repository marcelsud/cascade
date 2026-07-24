import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createMappingProcessor } from "../../../src/processors/mapping-processor.js";
import { createMessage } from "../../../src/core/types.js";

describe("MappingProcessor", () => {
  it("should transform simple fields with JSONata", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "fullName": firstName & " " & lastName,
          "age": age
        }
      `,
    });

    const message = createMessage({
      firstName: "John",
      lastName: "Doe",
      age: 30,
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result.content).toEqual({
      fullName: "John Doe",
      age: 30,
    });
  });

  it("should perform uppercase transformation", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "name": $uppercase(name),
          "email": $lowercase(email)
        }
      `,
    });

    const message = createMessage({
      name: "john doe",
      email: "JOHN@EXAMPLE.COM",
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result.content).toEqual({
      name: "JOHN DOE",
      email: "john@example.com",
    });
  });

  it("should handle array operations", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "total": $sum(items.price),
          "count": $count(items),
          "names": items.name
        }
      `,
    });

    const message = createMessage({
      items: [
        { name: "Apple", price: 1.5 },
        { name: "Banana", price: 0.8 },
        { name: "Orange", price: 1.2 },
      ],
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result.content.total).toBe(3.5);
    expect(result.content.count).toBe(3);
    // JSONata returns arrays as-is, not nested
    expect(Array.isArray(result.content.names)).toBe(true);
    expect(result.content.names).toHaveLength(3);
  });

  it("should handle filtering and mapping", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "highValueItems": items[price > 1].{
            "name": name,
            "price": price
          }
        }
      `,
    });

    const message = createMessage({
      items: [
        { name: "Apple", price: 1.5 },
        { name: "Banana", price: 0.8 },
        { name: "Orange", price: 1.2 },
      ],
    });

    const result = await Effect.runPromise(processor.process(message));

    // Check the values directly (JSONata objects don't work well with deep equality)
    expect(Array.isArray(result.content.highValueItems)).toBe(true);
    expect(result.content.highValueItems).toHaveLength(2);
    expect(result.content.highValueItems[0].name).toBe("Apple");
    expect(result.content.highValueItems[0].price).toBe(1.5);
    expect(result.content.highValueItems[1].name).toBe("Orange");
    expect(result.content.highValueItems[1].price).toBe(1.2);
  });

  it("should access message metadata via $meta", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "data": name,
          "messageId": $message.id,
          "timestamp": $message.timestamp,
          "metadata": $meta
        }
      `,
    });

    const message = createMessage(
      { name: "test" },
      { source: "api", version: "1.0" },
    );

    const result = await Effect.runPromise(processor.process(message));

    expect(result.content.data).toBe("test");
    expect(result.content.messageId).toBe(message.id);
    expect(result.content.timestamp).toBe(message.timestamp);
    expect(result.content.metadata.source).toBe("api");
    expect(result.content.metadata.version).toBe("1.0");
  });

  it("should handle conditional logic", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "name": name,
          "category": price > 100 ? "expensive" : "affordable",
          "discount": price > 100 ? 0.15 : 0.05
        }
      `,
    });

    const message1 = createMessage({ name: "Laptop", price: 1200 });
    const message2 = createMessage({ name: "Mouse", price: 25 });

    const result1 = await Effect.runPromise(processor.process(message1));
    const result2 = await Effect.runPromise(processor.process(message2));

    expect(result1.content.category).toBe("expensive");
    expect(result1.content.discount).toBe(0.15);

    expect(result2.content.category).toBe("affordable");
    expect(result2.content.discount).toBe(0.05);
  });

  it("should handle nested transformations", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "user": {
            "fullName": $uppercase(user.firstName) & " " & $uppercase(user.lastName),
            "contact": {
              "email": $lowercase(user.email),
              "phone": user.phone
            }
          },
          "orderTotal": $sum(orders.total)
        }
      `,
    });

    const message = createMessage({
      user: {
        firstName: "john",
        lastName: "doe",
        email: "JOHN@EXAMPLE.COM",
        phone: "123-456-7890",
      },
      orders: [{ total: 100 }, { total: 250 }, { total: 75 }],
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result.content.user.fullName).toBe("JOHN DOE");
    expect(result.content.user.contact.email).toBe("john@example.com");
    expect(result.content.orderTotal).toBe(425);
  });

  it("should add metadata about mapping", async () => {
    const processor = createMappingProcessor({
      expression: `{ "value": value }`,
    });

    const message = createMessage({ value: 42 });

    const result = await Effect.runPromise(processor.process(message));

    expect(result.metadata.mappingApplied).toBe(true);
    expect(result.metadata.mappingExpression).toBeDefined();
  });

  it("should handle errors gracefully", async () => {
    const processor = createMappingProcessor({
      expression: `{ "result": nonExistentField.foo.bar }`,
    });

    const message = createMessage({ value: 42 });

    // This should not throw, JSONata returns undefined for missing fields
    const result = await Effect.runPromise(processor.process(message));
    expect(result.content.result).toBeUndefined();
  });

  it("should fail on invalid JSONata expression compilation", () => {
    expect(() => {
      createMappingProcessor({
        expression: `{ invalid syntax here `,
      });
    }).toThrow();
  });

  it("should handle complex aggregations", async () => {
    const processor = createMappingProcessor({
      expression: `
        {
          "stats": {
            "avg": $average(values),
            "max": $max(values),
            "min": $min(values),
            "sum": $sum(values)
          }
        }
      `,
    });

    const message = createMessage({
      values: [10, 20, 30, 40, 50],
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result.content.stats.avg).toBe(30);
    expect(result.content.stats.max).toBe(50);
    expect(result.content.stats.min).toBe(10);
    expect(result.content.stats.sum).toBe(150);
  });

  it("should keep $message and $meta bindings isolated under concurrency", async () => {
    const processor = createMappingProcessor({
      expression: `{
        "workerId": workerId,
        "boundMessageId": $message.id,
        "boundSource": $meta.source,
        "boundToken": $meta.token
      }`,
    });

    const messages = Array.from({ length: 40 }, (_, index) =>
      createMessage(
        { workerId: index },
        { source: `source-${index}`, token: `token-${index}` },
      ),
    );

    const results = await Effect.runPromise(
      Effect.forEach(messages, (message) => processor.process(message), {
        concurrency: 10,
      }),
    );

    expect(results).toHaveLength(messages.length);

    for (let index = 0; index < messages.length; index++) {
      const source = messages[index];
      const result = results[index];

      expect(result.id).toBe(source.id);
      expect(result.content.workerId).toBe(index);
      expect(result.content.boundMessageId).toBe(source.id);
      expect(result.content.boundSource).toBe(`source-${index}`);
      expect(result.content.boundToken).toBe(`token-${index}`);
    }
  });
});
