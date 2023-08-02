import { TY_I32, TY_INT, TyStruct } from "./ast";
import { layoutOfStruct } from "./lower";

it("should compute struct layout correctly", () => {
  const ty: TyStruct = {
    kind: "struct",
    name: "",
    fields: [
      ["uwu", TY_I32],
      ["owo", TY_INT],
    ],
  };

  const layout = layoutOfStruct(ty);

  expect(layout).toMatchInlineSnapshot(`
    {
      "align": 8,
      "fields": [
        {
          "ty": {
            "kind": "i32",
          },
          "types": [
            {
              "offset": 4,
              "type": "i32",
            },
          ],
        },
        {
          "ty": {
            "kind": "int",
          },
          "types": [
            {
              "offset": 8,
              "type": "i64",
            },
          ],
        },
      ],
      "size": 16,
    }
  `);
});