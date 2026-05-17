from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "public" / "zork1-game-data.json"


@dataclass(frozen=True)
class ZString:
    value: str


ZExpr = str | ZString | list["ZExpr"]


DIRECTION_MAP = {
    "NORTH": "north",
    "SOUTH": "south",
    "EAST": "east",
    "WEST": "west",
    "UP": "up",
    "DOWN": "down",
    "NE": "northeast",
    "NW": "northwest",
    "SE": "southeast",
    "SW": "southwest",
    "IN": "in",
    "OUT": "out",
}

PREPOSITIONS = {
    "ABOUT",
    "ACROSS",
    "AT",
    "AWAY",
    "BEHIND",
    "DOWN",
    "FOR",
    "FROM",
    "IN",
    "INSIDE",
    "INTO",
    "OFF",
    "ON",
    "ONTO",
    "OUT",
    "OVER",
    "THROUGH",
    "THRU",
    "TO",
    "UNDER",
    "UP",
    "WITH",
    "USING",
}

MINIMUM_VERBS = {
    "take",
    "drop",
    "look",
    "examine",
    "north",
    "south",
    "east",
    "west",
    "up",
    "down",
    "open",
    "close",
    "attack",
    "kill",
    "give",
    "read",
    "eat",
    "drink",
    "inventory",
}


def tokenize(text: str) -> list[str | ZString]:
    tokens: list[str | ZString] = []
    index = 0

    def skip_string(start: int) -> int:
        current_index = start + 1
        while current_index < len(text):
            if text[current_index] == "\\" and current_index + 1 < len(text):
                current_index += 2
                continue
            if text[current_index] == '"':
                return current_index + 1
            current_index += 1
        return current_index

    def skip_commented_expression(start: int) -> int:
        current_index = start
        while current_index < len(text) and text[current_index].isspace():
            current_index += 1

        if current_index >= len(text):
            return current_index

        if text[current_index] == '"':
            return skip_string(current_index)

        if text[current_index] not in "<(":
            while current_index < len(text) and not text[current_index].isspace():
                current_index += 1
            return current_index

        terminators = {"<": ">", "(": ")"}
        stack = [terminators[text[current_index]]]
        current_index += 1

        while current_index < len(text) and stack:
            current = text[current_index]
            if current == ";":
                current_index = skip_commented_expression(current_index + 1)
                continue
            if current == '"':
                current_index = skip_string(current_index)
                continue
            if current in terminators:
                stack.append(terminators[current])
                current_index += 1
                continue
            if current == stack[-1]:
                stack.pop()
                current_index += 1
                continue
            current_index += 1

        return current_index

    while index < len(text):
        char = text[index]

        if char.isspace():
            index += 1
            continue

        if char == ";":
            index = skip_commented_expression(index + 1)
            continue

        if char == '"':
            string_start = index
            index += 1
            buffer: list[str] = []
            while index < len(text):
                current = text[index]
                if current == "\\" and index + 1 < len(text):
                    buffer.append(text[index + 1])
                    index += 2
                    continue
                if current == '"':
                    index += 1
                    break
                buffer.append(current)
                index += 1
            else:
                index = skip_string(string_start)
            tokens.append(ZString("".join(buffer)))
            continue

        if char in "<>()":
            tokens.append(char)
            index += 1
            continue

        start = index
        while index < len(text):
            current = text[index]
            if current.isspace() or current in "<>();":
                break
            if current == '"' and not (index > start and text[index - 1] == "\\"):
                break
            index += 1
        tokens.append(text[start:index])

    return tokens


class Parser:
    def __init__(self, tokens: list[str | ZString]):
        self.tokens = tokens
        self.index = 0

    def parse_all(self) -> list[ZExpr]:
        expressions: list[ZExpr] = []
        while self.index < len(self.tokens):
            expressions.append(self.parse_expr())
        return expressions

    def parse_expr(self) -> ZExpr:
        token = self.tokens[self.index]
        self.index += 1

        if token == "<":
            return self.parse_list(">")
        if token == "(":
            return self.parse_list(")")
        if token in {">",
            ")",
        }:
            raise ValueError(f"Unexpected closing token: {token}")
        return token

    def parse_list(self, terminator: str) -> list[ZExpr]:
        expressions: list[ZExpr] = []
        while self.index < len(self.tokens):
            if self.tokens[self.index] == terminator:
                self.index += 1
                return expressions
            expressions.append(self.parse_expr())
        raise ValueError(f"Missing closing token: {terminator}")


def parse_zil_file(path: Path) -> list[ZExpr]:
    return Parser(tokenize(path.read_text(encoding="utf-8"))).parse_all()


def is_atom(expr: ZExpr, expected: str | None = None) -> bool:
    if not isinstance(expr, str):
        return False
    return expected is None or atom_name(expr) == expected


def atom_name(atom: str) -> str:
    return atom.strip().lstrip(",.").upper()


def atom_id(expr: ZExpr) -> str | None:
    if not isinstance(expr, str):
        return None
    return atom_name(expr)


def collect_forms(expressions: list[ZExpr], head: str) -> list[list[ZExpr]]:
    found: list[list[ZExpr]] = []

    def visit(expr: ZExpr) -> None:
        if not isinstance(expr, list):
            return
        if expr and is_atom(expr[0], head):
            found.append(expr)
        for child in expr:
            visit(child)

    for expression in expressions:
        visit(expression)
    return found


def form_properties(form: list[ZExpr]) -> dict[str, list[list[ZExpr]]]:
    properties: dict[str, list[list[ZExpr]]] = {}
    for item in form[2:]:
        if isinstance(item, list) and item and isinstance(item[0], str):
            properties.setdefault(atom_name(item[0]), []).append(item[1:])
    return properties


def first_string(values: list[ZExpr] | None) -> str | None:
    if not values:
        return None
    for value in values:
        if isinstance(value, ZString):
            return normalize_text(value.value)
    return None


def normalize_text(text: str) -> str:
    text = text.replace("|", "\n")
    return re.sub(r"\s+", " ", text).strip()


def contains_atom(expr: ZExpr, expected: str) -> bool:
    if isinstance(expr, str):
        return atom_name(expr) == expected
    if isinstance(expr, list):
        return any(contains_atom(child, expected) for child in expr)
    return False


def collect_tell_strings(expr: ZExpr) -> list[str]:
    strings: list[str] = []

    def visit(candidate: ZExpr) -> None:
        if not isinstance(candidate, list) or not candidate:
            return

        if is_atom(candidate[0], "TELL"):
            for child in candidate[1:]:
                if isinstance(child, ZString):
                    strings.append(child.value)
            return

        for child in candidate:
            visit(child)

    visit(expr)
    return strings


def look_description_from_routine(routine: list[ZExpr]) -> str | None:
    strings: list[str] = []

    def visit(expr: ZExpr) -> None:
        if not isinstance(expr, list) or not expr:
            return

        if isinstance(expr[0], list) and contains_atom(expr[0], "M-LOOK"):
            for child in expr[1:]:
                strings.extend(collect_tell_strings(child))
            return

        for child in expr:
            visit(child)

    visit(routine)
    if not strings:
        return None
    return normalize_text(" ".join(strings))


def property_atoms(properties: dict[str, list[list[ZExpr]]], name: str) -> list[str]:
    atoms: list[str] = []
    for prop in properties.get(name, []):
        for value in prop:
            value_id = atom_id(value)
            if value_id:
                atoms.append(value_id)
    return atoms


def parse_rooms(
    room_forms: list[list[ZExpr]],
    routines: dict[str, list[ZExpr]],
) -> dict[str, dict[str, Any]]:
    rooms: dict[str, dict[str, Any]] = {}

    for form in room_forms:
        room_id = atom_id(form[1]) if len(form) > 1 else None
        if not room_id:
            continue

        properties = form_properties(form)
        flags = set(property_atoms(properties, "FLAGS"))
        actions = property_atoms(properties, "ACTION")
        exits = {direction: None for direction in DIRECTION_MAP.values()}

        for source_direction, output_direction in DIRECTION_MAP.items():
            for exit_prop in properties.get(source_direction, []):
                target = None
                if exit_prop and is_atom(exit_prop[0], "TO") and len(exit_prop) > 1:
                    target = atom_id(exit_prop[1])
                exits[output_direction] = target

        description = (
            first_string(properties.get("LDESC", [])[0] if properties.get("LDESC") else None)
            or next(
                (
                    look_description_from_routine(routines[action])
                    for action in actions
                    if action in routines
                    and look_description_from_routine(routines[action]) is not None
                ),
                None,
            )
            or first_string(properties.get("DESC", [])[0] if properties.get("DESC") else None)
            or room_id.replace("-", " ").title()
        )

        rooms[room_id] = {
            "name": first_string(properties.get("DESC", [])[0] if properties.get("DESC") else None)
            or room_id.replace("-", " ").title(),
            "description": description,
            "exits": exits,
            "is_dark": "ONBIT" not in flags,
            "objects_starting_here": [],
            "action_handlers": actions,
            "source_id": room_id,
        }

    return rooms


def parse_objects(object_forms: list[list[ZExpr]]) -> dict[str, dict[str, Any]]:
    objects: dict[str, dict[str, Any]] = {}

    for form in object_forms:
        object_id = atom_id(form[1]) if len(form) > 1 else None
        if not object_id:
            continue

        properties = form_properties(form)
        flags = set(property_atoms(properties, "FLAGS"))
        synonyms = property_atoms(properties, "SYNONYM")
        adjectives = property_atoms(properties, "ADJECTIVE")
        actions = property_atoms(properties, "ACTION")
        starting_location = None
        if properties.get("IN") and properties["IN"][0]:
            starting_location = atom_id(properties["IN"][0][0])

        name = (
            first_string(properties.get("DESC", [])[0] if properties.get("DESC") else None)
            or object_id.replace("-", " ").lower()
        )
        description = (
            first_string(properties.get("LDESC", [])[0] if properties.get("LDESC") else None)
            or first_string(properties.get("FDESC", [])[0] if properties.get("FDESC") else None)
            or name
        )

        objects[object_id] = {
            "name": name,
            "description": description,
            "starting_location": starting_location,
            "is_container": "CONTBIT" in flags,
            "is_takeable": "TAKEBIT" in flags,
            "is_npc": "ACTORBIT" in flags,
            "synonyms": sorted(normalize_word(word) for word in synonyms if normalize_word(word)),
            "adjectives": sorted(
                normalize_word(word) for word in adjectives if normalize_word(word)
            ),
            "flags": sorted(flags),
            "action_handlers": actions,
            "source_id": object_id,
        }

    if "LAMP" in objects and "LANTERN" not in objects:
        lantern = dict(objects["LAMP"])
        lantern["source_id"] = "LAMP"
        objects["LANTERN"] = lantern

    return objects


def assign_room_objects(
    rooms: dict[str, dict[str, Any]], objects: dict[str, dict[str, Any]]
) -> None:
    def containing_room(object_id: str) -> str | None:
        seen: set[str] = set()
        location = objects[object_id].get("starting_location")
        while isinstance(location, str) and location not in seen:
            if location in rooms:
                return location
            seen.add(location)
            if location not in objects:
                return None
            location = objects[location].get("starting_location")
        return None

    for object_id in sorted(objects):
        room_id = containing_room(object_id)
        if room_id:
            rooms[room_id]["objects_starting_here"].append(object_id)


def normalize_word(raw: str) -> str:
    word = atom_name(raw).replace("\\", "")
    word = word.lstrip("#$")
    aliases = {
        "N": "north",
        "S": "south",
        "E": "east",
        "W": "west",
        "U": "up",
        "D": "down",
        "NE": "northeast",
        "NORTHE": "northeast",
        "NW": "northwest",
        "SE": "southeast",
        "SOUTHE": "southeast",
        "SW": "southwest",
    }
    if word in aliases:
        return aliases[word]
    word = re.sub(r"[^A-Z0-9-]", "", word)
    return word.lower()


def syntax_verbs_and_combinations(
    syntax_forms: list[list[ZExpr]],
    synonym_forms: list[list[ZExpr]],
    direction_forms: list[list[ZExpr]],
) -> tuple[list[str], list[dict[str, str]]]:
    verbs: set[str] = set()
    combinations: set[tuple[str, str]] = set()

    for form in syntax_forms:
        if len(form) < 2 or not isinstance(form[1], str):
            continue
        verb = normalize_word(form[1])
        if not verb:
            continue
        verbs.add(verb)

        before_equals: list[ZExpr] = []
        for token in form[2:]:
            if is_atom(token, "="):
                break
            before_equals.append(token)

        for token in before_equals:
            if isinstance(token, str) and atom_name(token) in PREPOSITIONS:
                combinations.add((verb, normalize_word(token)))

    for form in synonym_forms:
        for token in form[1:]:
            if isinstance(token, str):
                word = normalize_word(token)
                if word:
                    verbs.add(word)

    for form in direction_forms:
        for token in form[1:]:
            if isinstance(token, str):
                direction = normalize_word(token)
                if direction:
                    verbs.add(direction)

    verbs.update(MINIMUM_VERBS)
    verbs.update({"northeast", "northwest", "southeast", "southwest", "in", "out"})

    return sorted(verbs), [
        {"verb": verb, "preposition": preposition}
        for verb, preposition in sorted(combinations)
    ]


def build_game_data(source_root: Path) -> dict[str, Any]:
    dungeon = parse_zil_file(source_root / "1dungeon.zil")
    actions = parse_zil_file(source_root / "1actions.zil")
    syntax = parse_zil_file(source_root / "gsyntax.zil")

    routine_forms = collect_forms(actions, "ROUTINE")
    routines = {
        atom_id(form[1]): form
        for form in routine_forms
        if len(form) > 1 and atom_id(form[1])
    }
    rooms = parse_rooms(collect_forms(dungeon, "ROOM"), routines)
    objects = parse_objects(collect_forms(dungeon, "OBJECT"))
    assign_room_objects(rooms, objects)
    verbs, combinations = syntax_verbs_and_combinations(
        collect_forms(syntax, "SYNTAX"),
        collect_forms(syntax, "SYNONYM"),
        collect_forms(dungeon, "DIRECTIONS"),
    )

    return {
        "schema_version": 1,
        "source": {
            "story_file": "zork1.z3",
            "zil_files": ["1dungeon.zil", "1actions.zil", "gsyntax.zil"],
        },
        "rooms": rooms,
        "objects": objects,
        "verbs": verbs,
        "verb_object_combinations": combinations,
    }


def validate_game_data(game_data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    rooms = game_data["rooms"]
    objects = game_data["objects"]
    verbs = set(game_data["verbs"])
    combinations = game_data["verb_object_combinations"]

    def expect(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    expect("WEST-OF-HOUSE" in rooms, "rooms.WEST-OF-HOUSE is missing")
    if "WEST-OF-HOUSE" in rooms:
        west = rooms["WEST-OF-HOUSE"]
        expect(west["name"] == "West of House", "WEST-OF-HOUSE name mismatch")
        expect(
            west["exits"].get("north") == "NORTH-OF-HOUSE",
            "WEST-OF-HOUSE north exit mismatch",
        )
        expect(west["exits"].get("east") is None, "WEST-OF-HOUSE east exit must be null")

    expect("KITCHEN" in rooms, "rooms.KITCHEN is missing")
    if "KITCHEN" in rooms:
        expect(rooms["KITCHEN"]["is_dark"] is False, "KITCHEN should not be dark")

    expect("CELLAR" in rooms, "rooms.CELLAR is missing")
    if "CELLAR" in rooms:
        expect(rooms["CELLAR"]["is_dark"] is True, "CELLAR should be dark")

    expect("MAILBOX" in objects, "objects.MAILBOX is missing")
    if "MAILBOX" in objects:
        mailbox = objects["MAILBOX"]
        expect(
            mailbox["starting_location"] == "WEST-OF-HOUSE",
            "MAILBOX starting_location mismatch",
        )
        expect(mailbox["is_container"] is True, "MAILBOX should be a container")

    expect("LANTERN" in objects, "objects.LANTERN is missing")
    expect("TROLL" in objects, "objects.TROLL is missing")
    if "TROLL" in objects:
        expect(objects["TROLL"]["is_npc"] is True, "TROLL should be marked as an NPC")

    missing_verbs = sorted(MINIMUM_VERBS - verbs)
    expect(not missing_verbs, f"Missing required verbs: {', '.join(missing_verbs)}")
    expect(
        {"verb": "attack", "preposition": "with"} in combinations,
        "Missing attack/with verb-object combination",
    )

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract static Zork I room, object, and parser metadata from ZIL."
    )
    parser.add_argument(
        "--source-root",
        type=Path,
        default=ROOT,
        help="Directory containing the Zork I ZIL source files.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_PATH,
        help="JSON output path.",
    )
    args = parser.parse_args()

    game_data = build_game_data(args.source_root)
    errors = validate_game_data(game_data)
    if errors:
        print("ZIL preprocessing validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(game_data, indent=2) + "\n", encoding="utf-8")
    print(
        "Wrote "
        f"{args.output} with {len(game_data['rooms'])} rooms, "
        f"{len(game_data['objects'])} objects, and {len(game_data['verbs'])} verbs."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
