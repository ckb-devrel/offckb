.PHONY: all omnilock anyone-can-pay xudt spore ckb-js-vm nostr-lock

all: omnilock anyone-can-pay xudt spore ckb-js-vm nostr-lock pw-lock secp256k1_multisig_v2

omnilock:
	@echo "Building omnilock via submodule"
	cd ckb/omnilock && git submodule update --init && make all-via-docker
	cp ckb/omnilock/build/always_success ckb/devnet/specs/
	cp ckb/omnilock/build/omni_lock ckb/devnet/specs/

anyone-can-pay:
	@echo "Building anyone-can-pay via submodule"
	cd ckb/anyone-can-pay && git submodule update --init && make all-via-docker
	cp ckb/anyone-can-pay/build/anyone_can_pay ckb/devnet/specs/

xudt:
	@echo "Building xUDT via submodule"
	cd ckb/ckb-production-scripts && git submodule update --init && make all-via-docker
	cp ckb/ckb-production-scripts/build/xudt_rce ckb/devnet/specs/
	cp ckb/ckb-production-scripts/build/simple_udt ckb/devnet/specs/sudt

spore:
	@echo "Building Spore via submodule"
	cd ckb/spore-contract && cargo install cross --git https://github.com/cross-rs/cross
	cd ckb/spore-contract && capsule build --release
	cp ckb/spore-contract/build/release/spore ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/cluster ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/cluster_agent ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/cluster_proxy ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/spore_extension_lua ckb/devnet/specs/spore-scripts/

ckb-js-vm:
	@echo "Building ckb-js-vm via submodule"
	cd ckb/ckb-js-vm && git submodule update --init && make all
	cp ckb/ckb-js-vm/build/ckb-js-vm ckb/devnet/specs/ckb_js_vm

nostr-lock:
	@echo "Building nostr-lock via submodule"
	cd ckb/nostr-binding && make build
	cp ckb/nostr-binding/build/release/nostr-lock ckb/devnet/specs/nostr_lock

pw-lock:
	@echo "Building pw-lock via submodule"
	cp patches/pw-lock-protocol.h ckb/pw-lock/protocol.h
	mkdir -p ckb/pw-lock/build
	cd ckb/pw-lock && make all-via-docker
	mkdir -p ckb/devnet/specs/pw-lock/
	cp ckb/pw-lock/specs/cells/secp256k1_keccak256_sighash_all ckb/devnet/specs/pw-lock/
	cp ckb/pw-lock/specs/cells/secp256k1_keccak256_sighash_all_acpl ckb/devnet/specs/pw-lock/

secp256k1_multisig_v2:
	@echo "Building secp256k1_multisig_v2 via submodule"
	cd ckb/ckb-system-scripts/  && make all-via-docker
	cp ckb/ckb-system-scripts/specs/cells/secp256k1_blake160_multisig_all ckb/devnet/specs/secp256k1_blake160_multisig_all_v2