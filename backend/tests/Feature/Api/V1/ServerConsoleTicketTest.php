<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerConsoleTicketTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.token' => 'segreto-condiviso']);
        Http::preventStrayRequests();
    }

    public function test_ticket_requires_the_console_ability(): void
    {
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->abilities([ServerAbility::Power])->create();
        Sanctum::actingAs($user);

        $this->postJson(route('api.v1.servers.console.ticket', 'alfa'))->assertForbidden();
    }

    public function test_ticket_is_signed_for_one_server_and_expires_quickly(): void
    {
        $this->freezeTime();
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->abilities([ServerAbility::Console])->create();
        Sanctum::actingAs($user);

        $path = $this->postJson(route('api.v1.servers.console.ticket', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.expiresIn', 30)
            ->json('data.path');

        $this->assertStringStartsWith('/ws/servers/alfa/console?ticket=', $path);
        [$body, $signature] = explode('.', substr($path, strlen('/ws/servers/alfa/console?ticket=')));

        $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', "ws-ticket.{$body}", 'segreto-condiviso', true)), '+/', '-_'), '=');
        $this->assertSame($expected, $signature);
        $this->assertSame(
            ['s' => 'alfa', 'u' => $user->id, 'e' => now()->addSeconds(30)->getTimestamp()],
            json_decode(base64_decode(strtr($body, '-_', '+/')), true),
        );
    }
}
