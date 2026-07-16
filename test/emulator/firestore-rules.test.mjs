import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import {
    assertFails,
    initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc
} from "firebase/firestore";

const PROJECT_ID = "demo-roco-spring-rules";
let environment;

before(async () => {
    const rules = await readFile(new URL("../../firestore.rules", import.meta.url), "utf8");
    environment = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: { rules }
    });
});

after(async () => {
    await environment?.cleanup();
});

test("unauthenticated clients cannot read or write any private collection", async () => {
    const database = environment.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(database, "teams", "RoCo-1")));
    await assertFails(getDocs(collection(database, "registrationRequests")));
    await assertFails(setDoc(doc(database, "rateLimits", "attacker"), { count: 0 }));
});

test("authenticated clients cannot read or write their own or another team", async () => {
    const ownerDatabase = environment.authenticatedContext("owner-uid").firestore();
    const otherDatabase = environment.authenticatedContext("other-uid").firestore();

    await assertFails(getDoc(doc(ownerDatabase, "teamOwners", "owner-uid")));
    await assertFails(getDoc(doc(ownerDatabase, "teams", "RoCo-1")));
    await assertFails(getDoc(doc(otherDatabase, "teams", "RoCo-1")));
    await assertFails(setDoc(doc(ownerDatabase, "teams", "RoCo-1"), { ownerUid: "owner-uid" }));
});

test("the test suite is connected to the Firestore emulator", () => {
    assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^(?:127\.0\.0\.1|localhost):\d+$/u);
});
