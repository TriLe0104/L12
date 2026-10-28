#!/bin/bash

# --- Configurable variables ---
DURATION_MINUTES="${DURATION_MINUTES:-10}"
FIO_FILE_SIZE="${FIO_FILE_SIZE:-10G}"
FIO_NUM_JOBS="${FIO_NUM_JOBS:-8}"
FIO_IODEPTH="${FIO_IODEPTH:-1024}"
# ------------------------------

FIO_TMP_FILES_DIR="${FIO_TMP_FILES_DIR:-/tmp/fio-tmp-files}"
DURATION=$(( DURATION_MINUTES * 60 ))

echo "Running fio tests for $DURATION_MINUTES minutes each..."

mkdir -p "$FIO_TMP_FILES_DIR"

# Ensure fio is installed quietly
if ! command -v fio &> /dev/null; then
    echo "fio not found. Installing quietly..."
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fio
fi

# FIO commands with adjustable runtime
FIO_SEQ_READ_BW_CMD="fio --name=seq_read_bw --ioengine=libaio \
--directory=$FIO_TMP_FILES_DIR --direct=1 --blocksize=1M \
--readwrite=read --filesize=$FIO_FILE_SIZE --numjobs=$FIO_NUM_JOBS --iodepth=$FIO_IODEPTH \
--runtime=$DURATION --group_reporting --time_based=1"

FIO_SEQ_WRITE_BW_CMD="fio --name=seq_write_bw --ioengine=libaio \
--directory=$FIO_TMP_FILES_DIR --direct=1 --blocksize=1M \
--readwrite=write --filesize=$FIO_FILE_SIZE --numjobs=$FIO_NUM_JOBS --iodepth=$FIO_IODEPTH \
--runtime=$DURATION --group_reporting --time_based=1"

FIO_SEQ_WRITE_IOPS_CMD="fio --name=seq_write_iops --ioengine=libaio \
--directory=$FIO_TMP_FILES_DIR --direct=1 --blocksize=4K \
--readwrite=write --filesize=$FIO_FILE_SIZE --numjobs=$FIO_NUM_JOBS --iodepth=$FIO_IODEPTH \
--runtime=$DURATION --group_reporting --time_based=1"

FIO_SEQ_READ_IOPS_CMD="fio --name=seq_read_iops --ioengine=libaio \
--directory=$FIO_TMP_FILES_DIR --direct=1 --blocksize=4K \
--readwrite=read --filesize=$FIO_FILE_SIZE --numjobs=$FIO_NUM_JOBS --iodepth=$FIO_IODEPTH \
--runtime=$DURATION --group_reporting --time_based=1"

# Run the tests sequentially
echo "Running sequential read bandwidth test..."
$FIO_SEQ_READ_BW_CMD

echo "Running sequential write bandwidth test..."
$FIO_SEQ_WRITE_BW_CMD

echo "Running sequential write IOPS test..."
$FIO_SEQ_WRITE_IOPS_CMD

echo "Running sequential read IOPS test..."
$FIO_SEQ_READ_IOPS_CMD
