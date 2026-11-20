<?php

namespace Tests\Feature\Api\V1;

use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class LocaleTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
        $this->withHeader('Referer', config('app.url'));
    }

    public function test_messages_are_in_english_by_default(): void
    {
        User::factory()->create(['email' => 'utente@example.com']);

        $this->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'sbagliata'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['email' => 'Wrong email or password.']);
    }

    public function test_messages_follow_the_accept_language_header(): void
    {
        User::factory()->create(['email' => 'utente@example.com']);

        $this->withHeader('Accept-Language', 'it')
            ->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'sbagliata'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['email' => 'Email o password non corretti.']);
    }

    public function test_validation_messages_are_translated(): void
    {
        $this->withHeader('Accept-Language', 'it')
            ->postJson(route('api.v1.auth.login'), [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['email' => 'Il campo email è obbligatorio.']);
    }

    public function test_unsupported_language_falls_back_to_english(): void
    {
        User::factory()->create(['email' => 'utente@example.com']);

        $this->withHeader('Accept-Language', 'de-DE')
            ->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'sbagliata'])
            ->assertJsonValidationErrors(['email' => 'Wrong email or password.']);
    }

    public function test_the_language_is_forwarded_to_the_agent(): void
    {
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->create();
        Sanctum::actingAs($user);
        Http::fake([self::AGENT_URL.'/servers' => Http::response(['data' => []])]);

        $this->withHeader('Accept-Language', 'it-IT,it;q=0.9')->getJson(route('api.v1.servers.index'))->assertOk();

        Http::assertSent(fn (Request $request): bool => $request->hasHeader('Accept-Language', 'it'));
    }
}
