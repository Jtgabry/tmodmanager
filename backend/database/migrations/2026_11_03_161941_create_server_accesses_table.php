<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('server_accesses', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            /** Id del server nel registry dell'agent (es. "alfa"). */
            $table->string('server_id', 32);
            /** Elenco di ServerAbility oltre a "view", che è implicito. */
            $table->json('abilities');
            $table->timestamps();

            $table->unique(['user_id', 'server_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('server_accesses');
    }
};
