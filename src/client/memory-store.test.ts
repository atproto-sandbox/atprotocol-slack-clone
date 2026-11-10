import { storeContract } from "@/testing/store-contract";
import { MemoryStore } from "./memory-store";

storeContract("memory store", async () => new MemoryStore());
