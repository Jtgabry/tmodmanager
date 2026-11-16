<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerConsoleTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_console_output_is_read_from_the_given_offset(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([self::AGENT_URL.'/servers/alfa/console*' => Http::response(['data' => ['offset' => 120, 'data' => "riga\n", 'reset' => false]])]);

        $this->getJson(route('api.v1.servers.console.show', ['server' => 'alfa', 'offset' => 100]))
            ->assertOk()
            ->assertExactJson(['data' => ['offset' => 120, 'data' => "riga\n", 'reset' => false]]);

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/console?offset=100');
    }

    public function test_first_read_has_no_offset(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([self::AGENT_URL.'/servers/alfa/console*' => Http::response(['data' => ['offset' => 5, 'data' => 'ciao', 'reset' => true]])]);

        $this->getJson(route('api.v1.servers.console.show', 'alfa'))->assertOk();

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/console');
    }

    public function test_invalid_offset_is_rejected(): void
    {
        $this->actingAsMember([ServerAbility::Console]);

        $this->getJson(route('api.v1.servers.console.show', ['server' => 'alfa', 'offset' => -1]))
            ->assertUnprocessable();

        Http::assertNothingSent();
    }

    public function test_console_requires_the_console_ability(): void
    {
        $this->actingAsMember([ServerAbility::Power]);

        $this->getJson(route('api.v1.servers.console.show', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.console.store', 'alfa'), ['command' => 'save'])->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_commands_are_forwarded_to_the_agent(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([self::AGENT_URL.'/servers/alfa/console' => Http::response(null, 204)]);

        $this->postJson(route('api.v1.servers.console.store', 'alfa'), ['command' => '  say ciao a tutti  '])
            ->assertNoContent();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST' && $request['command'] === 'say ciao a tutti');
    }

    public function test_multiline_or_control_characters_are_rejected(): void
    {
        $this->actingAsMember([ServerAbility::Console]);

        foreach (["save\nexit", "say \e[2J", ''] as $command) {
            $this->postJson(route('api.v1.servers.console.store', 'alfa'), ['command' => $command])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('command');
        }

        Http::assertNothingSent();
    }

    public function test_exit_commands_also_require_the_power_ability(): void
    {
        $this->actingAsMember([ServerAbility::Console]);

        foreach (['exit', 'EXIT-nosave', ' exit '] as $command) {
            $this->postJson(route('api.v1.servers.console.store', 'alfa'), ['command' => $command])->assertForbidden();
        }

        Http::assertNothingSent();
    }

    public function test_members_with_power_can_send_exit(): void
    {
        $this->actingAsMember([ServerAbility::Console, ServerAbility::Power]);
        Http::fake([self::AGENT_URL.'/servers/alfa/console' => Http::response(null, 204)]);

        $this->postJson(route('api.v1.servers.console.store', 'alfa'), ['command' => 'exit'])->assertNoContent();
    }

    public function test_agent_conflict_when_server_is_off(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([self::AGENT_URL.'/servers/alfa/console' => Http::response(['error' => 'conflict', 'message' => 'Il server è spento'], 409)]);

        $this->postJson(route('api.v1.servers.console.store', 'alfa'), ['command' => 'save'])
            ->assertConflict()
            ->assertJsonPath('message', 'Il server è spento');
    }

    /**
     * @param  list<ServerAbility>  $abilities
     */
    private function actingAsMember(array $abilities): void
    {
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->abilities($abilities)->create();
        Sanctum::actingAs($user);
    }
}
