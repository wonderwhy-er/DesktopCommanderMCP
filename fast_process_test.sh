#!/bin/bash

echo "=== TIMING TEST: Fast Process with Long Timeout ==="
echo "Starting process that will finish in 5 seconds..."
echo "Timeout is set to 10 seconds"
echo "Question: Will it wait 10 seconds or finish at 5 seconds?"
echo ""

start_time=$(date +%s.%N)
echo "Process started at: $(date)"

# This will take exactly 5 seconds
sleep 5

end_time=$(date +%s.%N)
echo "Process finished at: $(date)"

runtime=$(echo "$end_time - $start_time" | bc)
echo "Actual runtime: ${runtime} seconds"

if (( $(echo "$runtime < 6" | bc -l) )); then
    echo "✅ SUCCESS: Process finished early (~5s), did not wait for full timeout (10s)"
else
    echo "❌ UNEXPECTED: Process took longer than expected"
fi